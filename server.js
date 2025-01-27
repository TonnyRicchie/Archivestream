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
    timeout: 60000,
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
            status: States.UPLOADING, 
            progress: 0, 
            message: 'Iniciando descarga...' 
        });

        const fileResponse = await fetch(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!fileResponse.ok) {
            throw new Error('Error al acceder al archivo');
        }

        const contentLength = fileResponse.headers.get('content-length');
        let downloadedSize = 0;
        const chunks = [];

        // Stream de descarga con progreso
        for await (const chunk of fileResponse.body) {
            chunks.push(chunk);
            downloadedSize += chunk.length;
            
            updateProgress(socketId, {
                status: States.UPLOADING,
                progress: (downloadedSize / contentLength) * 50,
                message: 'Descargando archivo...'
            });
        }

        const buffer = Buffer.concat(chunks);
        const identifier = `${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;

        updateProgress(socketId, {
            status: States.UPLOADING,
            progress: 50,
            message: 'Iniciando subida a Archive.org...'
        });

        // Subida a Archive.org con progreso
        let uploadedSize = 0;
        const uploadStream = new stream.Readable();
        uploadStream._read = () => {};
        uploadStream.push(buffer);
        uploadStream.push(null);

        const progressStream = new stream.Transform({
            transform(chunk, encoding, callback) {
                uploadedSize += chunk.length;
                updateProgress(socketId, {
                    status: States.UPLOADING,
                    progress: 50 + (uploadedSize / buffer.length) * 50,
                    message: 'Subiendo a Archive.org...'
                });
                callback(null, chunk);
            }
        });

        const { accessKey, secretKey } = sessions[sessionId];

        const uploadResponse = await fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
            method: 'PUT',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`,
                'Content-Type': 'video/mp4',
                'Content-Length': buffer.length.toString(),
                'x-archive-queue-derive': '0',
                'x-archive-auto-make-bucket': '1',
                'x-archive-meta-mediatype': 'movies',
                'x-archive-meta-title': title,
                'x-archive-meta-description': description || '',
                'x-archive-meta-collection': collection
            },
            body: uploadStream.pipe(progressStream)
        });

        if (!uploadResponse.ok) {
            throw new Error('Error en la subida a Archive.org');
        }

        // Esperar procesamiento
        updateProgress(socketId, {
            status: States.PROCESSING,
            progress: 100,
            message: 'Finalizando procesamiento...'
        });

        await new Promise(resolve => setTimeout(resolve, 5000));

        // Obtener URLs finales
        const streamUrl = await getCorrectStreamUrl(identifier, fileName);

        res.json({
            success: true,
            identifier,
            urls: {
                page: `https://archive.org/details/${identifier}`,
                download: `https://archive.org/download/${identifier}/${fileName}`,
                stream: streamUrl
            }
        });

    } catch (error) {
        updateProgress(socketId, {
            status: States.ERROR,
            message: error.message
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
        const { accessKey, username } = sessions[sessionId];

        // Búsqueda por Access Key (S3)
        const s3SearchUrl = `https://archive.org/advancedsearch.php?q=uploader:(${encodeURIComponent(accessKey)})&fl[]=identifier,title,description&sort[]=addeddate+desc&output=json&rows=50`;
        
        // Búsqueda por nombre de usuario
        const userSearchUrl = `https://archive.org/advancedsearch.php?q=uploader:(${encodeURIComponent(username)})&fl[]=identifier,title,description&sort[]=addeddate+desc&output=json&rows=50`;

        // Realizar ambas búsquedas
        const [s3Response, userResponse] = await Promise.all([
            fetch(s3SearchUrl).then(r => r.json()),
            fetch(userSearchUrl).then(r => r.json())
        ]);

        // Combinar y deduplicar resultados
        const allItems = new Map();

        // Agregar resultados de S3
        s3Response.response?.docs?.forEach(item => {
            allItems.set(item.identifier, item);
        });

        // Agregar resultados de usuario
        userResponse.response?.docs?.forEach(item => {
            allItems.set(item.identifier, item);
        });

        const items = Array.from(allItems.values());

        res.json({
            success: true,
            items: items.map(item => ({
                identifier: item.identifier,
                title: item.title || item.identifier,
                description: item.description || ''
            }))
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
        const response = await fetch(`https://archive.org/metadata/${identifier}`, {
            method: 'POST',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ...metadata,
                '-target': 'metadata'
            })
        });

        if (!response.ok) {
            throw new Error('Error al actualizar metadatos');
        }

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
    
    if (!sessions[sessionId]) {
        return res.status(401).json({ 
            success: false, 
            message: 'Sesión inválida' 
        });
    }

    const socketId = req.body.socketId;

    try {
        updateProgress(socketId, {
            status: States.UPLOADING,
            progress: 0,
            message: 'Iniciando descarga del nuevo archivo...'
        });

        // Proceso similar al de upload pero para agregar a item existente
        // ... [Código de descarga y subida similar al endpoint /upload]

        res.json({
            success: true,
            message: 'Archivo agregado correctamente',
            urls: {
                page: `https://archive.org/details/${identifier}`,
                download: `https://archive.org/download/${identifier}/${fileName}`
            }
        });

    } catch (error) {
        updateProgress(socketId, {
            status: States.ERROR,
            message: error.message
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
