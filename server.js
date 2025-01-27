const express = require('express');
const cors = require('cors');
const stream = require('stream');
const { promisify } = require('util');
const fetch = require('node-fetch');
const FormData = require('form-data');
const https = require('https');
const path = require('path');
const { InternetArchive } = require('internetarchive-sdk-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuración mejorada del agente HTTPS
const httpsAgent = new https.Agent({
    keepAlive: true,
    timeout: 60000,
    rejectUnauthorized: false
});

const pipeline = promisify(stream.pipeline);

// Estado global (considerar migrar a una base de datos en producción)
const sessions = {};
const uploadData = {};
const userStates = {};
const lastUpdateTime = {};

// Estados de la aplicación
const States = {
    IDLE: 'IDLE',
    UPLOADING: 'UPLOADING',
    PROCESSING: 'PROCESSING',
    ERROR: 'ERROR'
};

// Rutas API

// Ruta de login
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
            const sessionId = Date.now().toString();
            sessions[sessionId] = { accessKey, secretKey };
            
            res.json({
                success: true,
                sessionId,
                message: 'Login exitoso'
            });
        } else {
            throw new Error('Credenciales inválidas');
        }
    } catch (error) {
        res.status(401).json({
            success: false,
            message: 'Error de autenticación: ' + error.message
        });
    }
});

// Ruta para subir archivo
app.post('/api/upload', async (req, res) => {
    const { sessionId, fileUrl, title, description, collection } = req.body;
    
    if (!sessions[sessionId]) {
        return res.status(401).json({
            success: false,
            message: 'Sesión no válida'
        });
    }

    try {
        const uploadSession = {
            fileUrl,
            title,
            description,
            collection,
            accessKey: sessions[sessionId].accessKey,
            secretKey: sessions[sessionId].secretKey
        };

        // Iniciar proceso de subida
        const uploadResult = await uploadToArchive(uploadSession);

        res.json({
            success: true,
            data: uploadResult
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error en la subida: ' + error.message
        });
    }
});

// Ruta para obtener estado de la subida
app.get('/api/upload-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const status = uploadData[sessionId] || { state: States.IDLE };
    res.json(status);
});

// Función principal de subida
async function uploadToArchive(uploadSession) {
    const { fileUrl, title, description, collection, accessKey, secretKey } = uploadSession;

    try {
        // Descargar archivo
        const response = await fetch(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) throw new Error('Error al obtener el archivo');

        const buffer = await response.buffer();
        const fileName = fileUrl.split('/').pop().split('?')[0] || 'video.mp4';
        const identifier = `${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;

        // Subir a Archive.org
        const uploadResponse = await fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
            method: 'PUT',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`,
                'Content-Type': 'video/mp4',
                'x-archive-meta-mediatype': 'movies',
                'x-archive-meta-title': title,
                'x-archive-meta-description': description || '',
                'x-archive-meta-collection': collection
            },
            body: buffer
        });

        if (!uploadResponse.ok) {
            throw new Error('Error en la subida a Archive.org');
        }

        return {
            success: true,
            identifier,
            urls: {
                page: `https://archive.org/details/${identifier}`,
                download: `https://archive.org/download/${identifier}/${fileName}`
            }
        };

    } catch (error) {
        throw error;
    }
}

// Funciones auxiliares
function formatProgress(progress, total) {
    const percent = (progress / total * 100).toFixed(1);
    const progressBar = '█'.repeat(Math.floor(progress / total * 20)) + '░'.repeat(20 - Math.floor(progress / total * 20));
    const downloaded = (progress / (1024 * 1024)).toFixed(2);
    const totalSize = (total / (1024 * 1024)).toFixed(2);
    return {
        percent,
        progressBar,
        downloaded,
        totalSize
    };
}

// Ruta para obtener buckets
app.get('/api/buckets/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    if (!sessions[sessionId]) {
        return res.status(401).json({
            success: false,
            message: 'Sesión no válida'
        });
    }

    try {
        const response = await fetch('https://s3.us.archive.org', {
            method: 'GET',
            headers: {
                'Authorization': `LOW ${sessions[sessionId].accessKey}:${sessions[sessionId].secretKey}`
            }
        });

        const data = await response.text();
        const buckets = Array.from(data.matchAll(/<Bucket><Name>(.+?)<\/Name><CreationDate>(.+?)<\/CreationDate><\/Bucket>/g))
            .map(match => ({
                name: match[1],
                creationDate: match[2]
            }));

        res.json({
            success: true,
            buckets
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error al obtener buckets: ' + error.message
        });
    }
});

// Ruta para agregar archivo a bucket existente
app.post('/api/buckets/:identifier/files', async (req, res) => {
    const { identifier } = req.params;
    const { sessionId, fileUrl, fileName } = req.body;

    if (!sessions[sessionId]) {
        return res.status(401).json({
            success: false,
            message: 'Sesión no válida'
        });
    }

    try {
        const result = await addFileToExisting(
            identifier,
            fileUrl,
            fileName,
            sessions[sessionId].accessKey,
            sessions[sessionId].secretKey
        );

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error al agregar archivo: ' + error.message
        });
    }
});

async function addFileToExisting(identifier, fileUrl, fileName, accessKey, secretKey) {
    try {
        const response = await fetch(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) throw new Error('Error al obtener el archivo');

        const totalSize = parseInt(response.headers.get('content-length'));
        const buffer = await response.buffer();

        const uploadResponse = await fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
            method: 'PUT',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`,
                'Content-Type': 'video/mp4',
                'Content-Length': buffer.length.toString(),
                'x-archive-queue-derive': '0',
                'x-archive-auto-make-bucket': '1',
                'x-archive-meta-mediatype': 'movies',
                'x-archive-size-hint': buffer.length.toString()
            },
            body: buffer
        });

        if (!uploadResponse.ok) {
            throw new Error(`Error en la subida: ${await uploadResponse.text()}`);
        }

        // Esperar para que Archive.org procese el archivo
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Obtener la URL del stream
        const directUrl = await getCorrectStreamUrl(identifier, fileName);

        return {
            success: true,
            urls: {
                page: `https://archive.org/details/${identifier}`,
                stream: directUrl,
                download: `https://archive.org/download/${identifier}/${fileName}`
            }
        };
    } catch (error) {
        throw error;
    }
}

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

// Ruta para buscar uploads del usuario
app.get('/api/uploads/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    if (!sessions[sessionId]) {
        return res.status(401).json({
            success: false,
            message: 'Sesión no válida'
        });
    }

    try {
        const accessKey = sessions[sessionId].accessKey;
        const username = sessions[sessionId].username;

        // Búsqueda por Access Key (S3)
        const s3SearchUrl = `https://archive.org/advancedsearch.php?q=uploader:(${encodeURIComponent(accessKey)})&fl[]=identifier,title,description,collection,addeddate,uploader,source,creator,name&sort[]=addeddate+desc&output=json&rows=1000`;
        
        // Búsqueda por nombre de usuario
        const userSearchUrl = `https://archive.org/advancedsearch.php?q=uploader:(${encodeURIComponent(username)})&fl[]=identifier,title,description,collection,addeddate,uploader,source,creator,name&sort[]=addeddate+desc&output=json&rows=1000`;

        const [s3Results, userResults] = await Promise.all([
            fetch(s3SearchUrl).then(r => r.json()),
            fetch(userSearchUrl).then(r => r.json())
        ]);

        // Combinar resultados
        const allItems = new Map();

        // Agregar resultados de S3
        s3Results.response?.docs?.forEach(item => {
            allItems.set(item.identifier, item);
        });

        // Agregar resultados de usuario
        userResults.response?.docs?.forEach(item => {
            allItems.set(item.identifier, item);
        });

        const uniqueItems = Array.from(allItems.values());

        res.json({
            success: true,
            uploads: uniqueItems
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error al obtener uploads: ' + error.message
        });
    }
});

// Ruta para verificar URL
app.post('/api/verify-url', async (req, res) => {
    const { url } = req.body;
    
    try {
        const response = await fetch(url, {
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            throw new Error('URL no accesible');
        }

        const contentLength = response.headers.get('content-length');
        const contentType = response.headers.get('content-type');

        res.json({
            success: true,
            fileInfo: {
                size: contentLength,
                type: contentType,
                fileName: url.split('/').pop().split('?')[0] || 'video.mp4'
            }
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: 'Error al verificar URL: ' + error.message
        });
    }
});

// WebSocket para actualizaciones en tiempo real
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server: app });

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'subscribe' && data.sessionId) {
            ws.sessionId = data.sessionId;
        }
    });
});

// Función para enviar actualizaciones de progreso
function broadcastProgress(sessionId, progress) {
    wss.clients.forEach((client) => {
        if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(progress));
        }
    });
}

// Middleware para manejar la autenticación
function authenticateSession(req, res, next) {
    const sessionId = req.headers['x-session-id'];
    if (!sessions[sessionId]) {
        return res.status(401).json({
            success: false,
            message: 'Sesión no válida'
        });
    }
    req.session = sessions[sessionId];
    next();
}

// Aplicar middleware de autenticación a rutas protegidas
app.use('/api/protected/*', authenticateSession);

// Limpieza periódica de sesiones inactivas
setInterval(() => {
    const now = Date.now();
    Object.keys(sessions).forEach(sessionId => {
        if (now - sessions[sessionId].lastActivity > 24 * 60 * 60 * 1000) { // 24 horas
            delete sessions[sessionId];
        }
    });
}, 60 * 60 * 1000); // Cada hora

// Ruta para obtener metadatos
app.get('/api/metadata/:identifier', async (req, res) => {
    try {
        const { identifier } = req.params;
        const response = await fetch(`https://archive.org/metadata/${identifier}`);
        const metadata = await response.json();
        res.json(metadata);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error al obtener metadatos'
        });
    }
});

// Ruta para actualizar metadatos
app.put('/api/metadata/:identifier', async (req, res) => {
    const { identifier } = req.params;
    const { sessionId, metadata } = req.body;

    if (!sessions[sessionId]) {
        return res.status(401).json({
            success: false,
            message: 'Sesión no válida'
        });
    }

    try {
        const response = await fetch(`https://archive.org/metadata/${identifier}`, {
            method: 'POST',
            headers: {
                'Authorization': `LOW ${sessions[sessionId].accessKey}:${sessions[sessionId].secretKey}`,
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

// Manejo de errores global
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});

module.exports = app;
