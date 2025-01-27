const express = require('express');
const cors = require('cors');
const stream = require('stream');
const { promisify } = require('util');
const fetch = require('node-fetch');
const FormData = require('form-data');
const https = require('https');
const { InternetArchive } = require('internetarchive-sdk-js');
const multer = require('multer');
const socketIo = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const pipeline = promisify(stream.pipeline);
const port = process.env.PORT || 3000;

// Configuración de CORS y middleware
app.use(cors());
app.use(express.json());

// Configuración de multer para subida de archivos
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 2147483648 } // 2GB límite
});

// Configuración del agente HTTPS
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 3000,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000, // 60 segundos
    rejectUnauthorized: false
});

// Almacenamiento en memoria
const sessions = {};
const uploadData = {};
const userStates = {};
const lastUpdateTime = {};

// Estados de subida
const States = {
    IDLE: 'IDLE',
    UPLOADING: 'UPLOADING',
    PROCESSING: 'PROCESSING',
    ERROR: 'ERROR'
};

// Aumentar límites para manejar archivos grandes
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ 
    limit: '500mb', 
    extended: true,
    parameterLimit: 50000 
}));

// Configuración adicional recomendada
app.use(express.raw({ limit: '500mb' }));
app.use(compression()); // Si tienes el módulo compression instalado

// Función para actualizar progreso vía Socket.IO
function updateProgress(socketId, progress) {
    io.to(socketId).emit('uploadProgress', progress);
}

// Endpoints principales

app.post('/api/login', async (req, res) => {
    const { accessKey, secretKey } = req.body;
    try {
        const response = await fetch('https://s3.us.archive.org', {
            method: 'GET',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`
            },
            agent: httpsAgent
        });

        if (response.ok) {
            const accountData = await response.text();
            const displayNameMatch = accountData.match(/<DisplayName>(.+?)<\/DisplayName>/);
            const username = displayNameMatch ? displayNameMatch[1] : 'Usuario';

            const sessionId = Date.now().toString();
            sessions[sessionId] = { 
                accessKey, 
                secretKey,
                username,
                createdAt: new Date()
            };

            res.json({ 
                success: true, 
                sessionId,
                username
            });
        } else {
            res.status(401).json({ 
                success: false, 
                message: 'Credenciales inválidas' 
            });
        }
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

app.post('/api/upload', async (req, res) => {
    const { sessionId, fileUrl, fileName, title, description, collection } = req.body;
    
    if (!sessions[sessionId]) {
        return res.status(401).json({ 
            success: false, 
            message: 'Sesión inválida' 
        });
    }

    const socketId = req.body.socketId;
    
    try {
        updateProgress(socketId, { 
            progress: 0, 
            message: 'Iniciando descarga...' 
        });

        // Agregar timeout y headers más completos
        const fileResponse = await fetch(fileUrl, {
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br'
            },
            agent: httpsAgent
        });

        if (!fileResponse.ok) {
            throw new Error(`Error al acceder al archivo: ${fileResponse.statusText}`);
        }

        const contentLength = fileResponse.headers.get('content-length');
        if (!contentLength) {
            throw new Error('No se pudo determinar el tamaño del archivo');
        }

        let downloadedSize = 0;
        const chunks = [];

        for await (const chunk of fileResponse.body) {
            chunks.push(chunk);
            downloadedSize += chunk.length;
            
            const progress = (downloadedSize / contentLength) * 50;
            updateProgress(socketId, {
                progress: progress,
                message: `Descargando archivo... ${Math.round(progress)}%`
            });
        }

        const buffer = Buffer.concat(chunks);
        const identifier = `${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;

        updateProgress(socketId, {
            progress: 50,
            message: 'Iniciando subida a Archive.org...'
        });

        let uploadedSize = 0;
        const uploadStream = new stream.Readable();
        uploadStream._read = () => {};
        uploadStream.push(buffer);
        uploadStream.push(null);

        const progressStream = new stream.Transform({
            transform(chunk, encoding, callback) {
                uploadedSize += chunk.length;
                const progress = 50 + (uploadedSize / buffer.length) * 50;
                updateProgress(socketId, {
                    progress: progress,
                    message: `Subiendo a Archive.org... ${Math.round(progress)}%`
                });
                callback(null, chunk);
            }
        });

        const { accessKey, secretKey } = sessions[sessionId];

        // Determinar el tipo de contenido basado en la extensión del archivo
        const contentType = fileName.endsWith('.mp4') ? 'video/mp4' : 
                          fileName.endsWith('.mkv') ? 'video/x-matroska' :
                          'application/octet-stream';

        const uploadResponse = await fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
            method: 'PUT',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`,
                'Content-Type': contentType,
                'Content-Length': buffer.length.toString(),
                'x-archive-queue-derive': '0',
                'x-archive-auto-make-bucket': '1',
                'x-archive-meta-mediatype': 'movies',
                'x-archive-meta-title': title,
                'x-archive-meta-description': description || '',
                'x-archive-meta-collection': collection,
                'x-archive-meta-creator': sessions[sessionId].username
            },
            body: uploadStream.pipe(progressStream)
        });

        if (!uploadResponse.ok) {
            throw new Error(`Error en la subida a Archive.org: ${uploadResponse.statusText}`);
        }

        updateProgress(socketId, {
            progress: 100,
            message: 'Finalizando procesamiento...'
        });

        await new Promise(resolve => setTimeout(resolve, 5000));

        res.json({
            success: true,
            identifier,
            urls: {
                page: `https://archive.org/details/${identifier}`,
                download: `https://archive.org/download/${identifier}/${fileName}`
            }
        });

    } catch (error) {
        console.error('Error completo:', error);
        updateProgress(socketId, {
            progress: 0,
            message: `Error: ${error.message}`
        });
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Función para obtener URL de stream
async function getCorrectStreamUrl(identifier, fileName) {
    try {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const response = await fetch(`https://archive.org/metadata/${identifier}`);
        const data = await response.json();
        
        if (data && data.files) {
            const file = data.files.find(f => f.name === fileName);
            if (file && file.format === 'h.264') {
                return `https://archive.org/download/${identifier}/${fileName}`;
            }
        }
        return null;
    } catch (error) {
        console.error('Error al obtener URL del stream:', error);
        return null;
    }
}

// Endpoint para obtener buckets
app.get('/api/buckets', async (req, res) => {
    const { sessionId } = req.query;
    if (!sessions[sessionId]) {
        return res.status(401).json({ 
            success: false, 
            message: 'Sesión inválida' 
        });
    }

    try {
        const { accessKey, secretKey } = sessions[sessionId];
        const response = await fetch('https://s3.us.archive.org', {
            method: 'GET',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`
            }
        });

        const data = await response.text();
        const buckets = Array.from(data.matchAll(/<Bucket><Name>(.+?)<\/Name><CreationDate>(.+?)<\/CreationDate><\/Bucket>/g))
            .map(match => ({
                name: match[1],
                creationDate: new Date(match[2]).toISOString(),
                url: `https://archive.org/details/${match[1]}`
            }));

        res.json({ 
            success: true, 
            buckets 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Endpoint para listar items del usuario
app.get('/api/items', async (req, res) => {
    const { sessionId } = req.query;
    if (!sessions[sessionId]) {
        return res.status(401).json({ 
            success: false, 
            message: 'Sesión inválida' 
        });
    }

    try {
        const { accessKey, secretKey } = sessions[sessionId];
        
        // Primero obtenemos los buckets como en el endpoint de buckets
        const bucketsResponse = await fetch('https://s3.us.archive.org', {
            method: 'GET',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`
            }
        });

        const bucketsData = await bucketsResponse.text();
        const buckets = Array.from(bucketsData.matchAll(/<Bucket><Name>(.+?)<\/Name><CreationDate>(.+?)<\/CreationDate><\/Bucket>/g));

        // Ahora obtenemos los detalles de cada bucket
        const items = await Promise.all(buckets.map(async ([_, name]) => {
            try {
                const metadataResponse = await fetch(`https://archive.org/metadata/${name}`);
                const metadata = await metadataResponse.json();
                
                return {
                    identifier: name,
                    title: metadata.metadata?.title || name,
                    description: metadata.metadata?.description || '',
                    collection: metadata.metadata?.collection || [],
                    addedDate: metadata.metadata?.addeddate || metadata.created,
                    files: metadata.files || [],
                    metadata: metadata.metadata || {}
                };
            } catch (error) {
                console.error(`Error obteniendo metadata para ${name}:`, error);
                return {
                    identifier: name,
                    title: name,
                    description: '',
                    collection: [],
                    addedDate: new Date().toISOString(),
                    files: [],
                    metadata: {}
                };
            }
        }));

        res.json({
            success: true,
            items: items.filter(item => item !== null)
        });

    } catch (error) {
        console.error('Error al listar items:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Endpoint para editar metadatos
app.post('/api/edit', async (req, res) => {
    const { sessionId, identifier, metadata } = req.body;
    if (!sessions[sessionId]) {
        return res.status(401).json({ 
            success: false, 
            message: 'Sesión inválida' 
        });
    }

    try {
        const { accessKey, secretKey } = sessions[sessionId];
        
        // Construir los headers de metadata
        const headers = {
            'Authorization': `LOW ${accessKey}:${secretKey}`,
            'x-archive-ignore-preexisting-bucket': '1'
        };

        // Agregar cada campo de metadata como un header
        Object.entries(metadata).forEach(([key, value]) => {
            headers[`x-archive-meta-${key}`] = value;
        });

        const response = await fetch(`https://s3.us.archive.org/${identifier}`, {
            method: 'PUT',
            headers: headers
        });

        if (!response.ok) {
            throw new Error('Error al actualizar metadatos');
        }

        // Esperar un momento para que los cambios se reflejen
        await new Promise(resolve => setTimeout(resolve, 2000));

        res.json({ 
            success: true,
            message: 'Metadatos actualizados correctamente'
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Endpoint para agregar archivo a item existente
app.post('/api/add-file', async (req, res) => {
    const { sessionId, identifier, fileUrl, fileName } = req.body;
    const socketId = req.body.socketId;
    
    if (!sessions[sessionId]) {
        return res.status(401).json({ 
            success: false, 
            message: 'Sesión inválida' 
        });
    }

    async function downloadFile(url, attempt = 1) {
        const MAX_ATTEMPTS = 3;
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const contentLength = parseInt(response.headers.get('content-length') || '0');
            let downloadedSize = 0;
            const chunks = [];

            const reader = response.body.getReader();

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                chunks.push(value);
                downloadedSize += value.length;

                if (contentLength > 0) {
                    const progress = (downloadedSize / contentLength) * 50;
                    io.to(socketId).emit('uploadProgress', {
                        progress,
                        message: `Descargando: ${Math.round(progress)}%`
                    });
                }
            }

            return Buffer.concat(chunks);

        } catch (error) {
            if (attempt < MAX_ATTEMPTS) {
                io.to(socketId).emit('uploadProgress', {
                    progress: 0,
                    message: `Reintentando descarga (${attempt}/${MAX_ATTEMPTS})...`
                });
                await new Promise(resolve => setTimeout(resolve, 2000));
                return downloadFile(url, attempt + 1);
            }
            throw error;
        }
    }

async function uploadToArchive(buffer) {
        const { accessKey, secretKey } = sessions[sessionId];
        const contentType = fileName.endsWith('.mp4') ? 'video/mp4' : 
                          fileName.endsWith('.mkv') ? 'video/x-matroska' :
                          fileName.endsWith('.webm') ? 'video/webm' :
                          'application/octet-stream';

        const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
        const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, buffer.length);
            const chunk = buffer.slice(start, end);

            const uploadResponse = await fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `LOW ${accessKey}:${secretKey}`,
                    'Content-Type': contentType,
                    'Content-Length': chunk.length.toString(),
                    'Content-Range': `bytes ${start}-${end-1}/${buffer.length}`,
                    'x-archive-queue-derive': '1',
                    'x-archive-ignore-preexisting-bucket': '1'
                },
                body: chunk
            });

            if (!uploadResponse.ok) {
                throw new Error(`Error en la subida: ${uploadResponse.statusText}`);
            }

            const progress = 50 + ((i + 1) / totalChunks) * 50;
            io.to(socketId).emit('uploadProgress', {
                progress,
                message: `Subiendo: ${Math.round(progress)}%`
            });
        }
    }

    try {
        io.to(socketId).emit('uploadProgress', {
            progress: 0,
            message: 'Iniciando descarga...'
        });

        const buffer = await downloadFile(fileUrl);

        io.to(socketId).emit('uploadProgress', {
            progress: 50,
            message: 'Iniciando subida...'
        });

        await uploadToArchive(buffer);

        io.to(socketId).emit('uploadProgress', {
            status: 'COMPLETE',
            progress: 100,
            message: 'Proceso completado'
        });

        res.json({
            success: true,
            message: 'Archivo agregado correctamente',
            urls: {
                page: `https://archive.org/details/${identifier}`,
                download: `https://archive.org/download/${identifier}/${fileName}`
            }
        });

    } catch (error) {
        console.error('Error:', error);
        io.to(socketId).emit('uploadProgress', {
            status: 'ERROR',
            message: `Error: ${error.message}`
        });
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Endpoint para obtener detalles de un item
app.get('/api/item/:identifier', async (req, res) => {
    const { sessionId } = req.query;
    const { identifier } = req.params;

    if (!sessions[sessionId]) {
        return res.status(401).json({ 
            success: false, 
            message: 'Sesión inválida' 
        });
    }

    try {
        const response = await fetch(`https://archive.org/metadata/${identifier}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error('Error al obtener información del item');
        }

        res.json({
            success: true,
            data
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Manejo de conexiones Socket.IO
io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
    });
});

// Iniciar servidor
server.listen(port, () => {
    console.log(`Servidor ejecutándose en el puerto ${port}`);
});
