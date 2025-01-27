const express = require('express');
const cors = require('cors');
const multer = require('multer');
const stream = require('stream');
const { promisify } = require('util');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');
const FormData = require('form-data');
const { InternetArchive } = require('internetarchive-sdk-js');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const pipeline = promisify(stream.pipeline);

// Configuración mejorada del agente HTTPS
const httpsAgent = new https.Agent({
    keepAlive: true,
    timeout: 60000,
    rejectUnauthorized: false
});

// Configuración de CORS mejorada
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configuración de multer para archivos
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 2000 * 1024 * 1024 // 2GB límite
    }
});

// Cache para sesiones de usuario
const sessions = new Map();
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 horas

// Middleware de autenticación
const authenticateSession = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new Error('No se proporcionó token de sesión');
        }

        const sessionId = authHeader.split(' ')[1];
        const session = sessions.get(sessionId);

        if (!session) {
            throw new Error('Sesión inválida o expirada');
        }

        if (Date.now() - session.timestamp > SESSION_DURATION) {
            sessions.delete(sessionId);
            throw new Error('Sesión expirada');
        }

        req.user = session;
        next();
    } catch (error) {
        res.status(401).json({
            success: false,
            message: error.message
        });
    }
};

// Rutas de la API

// Validar credenciales y crear sesión
app.post('/api/validate-credentials', async (req, res) => {
    try {
        const { accessKey, secretKey } = req.body;
        
        if (!accessKey || !secretKey) {
            throw new Error('Access Key y Secret Key son requeridos');
        }

        const response = await fetch('https://s3.us.archive.org', {
            method: 'GET',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`
            },
            agent: httpsAgent,
            timeout: 10000
        });

        if (response.ok) {
            const accountData = await response.text();
            const displayNameMatch = accountData.match(/<DisplayName>(.+?)<\/DisplayName>/);
            const username = displayNameMatch ? displayNameMatch[1] : 'Usuario';

            const sessionId = generateSessionId();
            sessions.set(sessionId, {
                accessKey,
                secretKey,
                username,
                timestamp: Date.now()
            });

            res.json({
                success: true,
                sessionId,
                username,
                message: 'Credenciales válidas'
            });
        } else {
            throw new Error('Credenciales inválidas');
        }
    } catch (error) {
        console.error('Error de validación:', error);
        res.status(401).json({
            success: false,
            message: error.message
        });
    }
});

// Verificar archivo antes de subir
app.post('/api/verify-file', async (req, res) => {
    try {
        const { fileUrl } = req.body;

        const response = await fetch(fileUrl, {
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            agent: httpsAgent,
            timeout: 10000
        });

        if (!response.ok) {
            throw new Error('No se puede acceder al archivo');
        }

        const contentLength = response.headers.get('content-length');
        const contentType = response.headers.get('content-type');

        if (contentLength && parseInt(contentLength) > 2000 * 1024 * 1024) {
            throw new Error('El archivo excede el límite de 2GB');
        }

        res.json({
            success: true,
            fileSize: contentLength,
            mimeType: contentType
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// Subir archivo a Archive.org
app.post('/api/upload', authenticateSession, async (req, res) => {
    try {
        const { fileUrl, fileName, title, description, collection, sessionId } = req.body;
        const { accessKey, secretKey } = req.user;

        // Validar campos requeridos
        if (!fileUrl || !title || !collection) {
            throw new Error('Faltan campos requeridos');
        }

        // Verificar URL del archivo
        const fileResponse = await fetch(fileUrl, {
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            agent: httpsAgent,
            timeout: 10000
        });

        if (!fileResponse.ok) {
            throw new Error('URL del archivo no válida');
        }

        const contentLength = fileResponse.headers.get('content-length');
        const identifier = `${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
        const fileName = path.basename(fileUrl).split('?')[0] || 'video.mp4';

        // Stream de descarga
        const downloadStream = await fetch(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            agent: httpsAgent
        });

        // Configurar subida a Archive.org
        const uploadResponse = await fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
            method: 'PUT',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`,
                'Content-Type': 'video/mp4',
                'Content-Length': contentLength,
                'x-archive-queue-derive': '0',
                'x-archive-auto-make-bucket': '1',
                'x-archive-meta-mediatype': 'movies',
                'x-archive-meta-title': title,
                'x-archive-meta-description': description || '',
                'x-archive-meta-collection': collection
            },
            body: downloadStream.body,
            agent: httpsAgent
        });

        if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text();
            throw new Error(`Error en la subida a Archive.org: ${errorText}`);
        }

        // Esperar procesamiento inicial
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Obtener metadatos del archivo
        const metadataResponse = await fetch(`https://archive.org/metadata/${identifier}`);
        const metadata = await metadataResponse.json();

        res.json({
            success: true,
            archiveUrl: `https://archive.org/details/${identifier}`,
            downloadUrl: `https://archive.org/download/${identifier}/${fileName}`,
            identifier,
            metadata
        });
    } catch (error) {
        console.error('Error en la subida:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Obtener buckets del usuario
app.get('/api/buckets', authenticateSession, async (req, res) => {
    try {
        const { accessKey, secretKey } = req.user;

        const response = await fetch('https://s3.us.archive.org', {
            method: 'GET',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`
            },
            agent: httpsAgent,
            timeout: 10000
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
        console.error('Error al obtener buckets:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Obtener detalles de un item
app.get('/api/item/:identifier', authenticateSession, async (req, res) => {
    try {
        const { identifier } = req.params;

        const metadataResponse = await fetch(`https://archive.org/metadata/${identifier}`);
        const metadata = await metadataResponse.json();

        if (!metadata.success) {
            throw new Error('No se encontró el item');
        }

        res.json({
            success: true,
            item: {
                identifier: metadata.metadata.identifier,
                title: metadata.metadata.title,
                description: metadata.metadata.description,
                collection: metadata.metadata.collection,
                files: metadata.files
            }
        });
    } catch (error) {
        console.error('Error al obtener detalles del item:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Actualizar metadatos de un item
app.post('/api/update-item', authenticateSession, async (req, res) => {
    try {
        const { identifier, title, description, collection } = req.body;
        const { accessKey, secretKey } = req.user;

        const response = await fetch(`https://archive.org/metadata/${identifier}`, {
            method: 'POST',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                metadata: {
                    title,
                    description,
                    collection
                },
                '-target': 'metadata'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Error al actualizar: ${errorText}`);
        }

        res.json({
            success: true,
            message: 'Metadatos actualizados correctamente'
        });
    } catch (error) {
        console.error('Error al actualizar metadatos:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Agregar archivo a un item existente
app.post('/api/add-file', authenticateSession, async (req, res) => {
    try {
        const { identifier, fileUrl, fileName } = req.body;
        const { accessKey, secretKey } = req.user;

        // Verificar URL del archivo
        const fileResponse = await fetch(fileUrl, {
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            agent: httpsAgent,
            timeout: 10000
        });

        if (!fileResponse.ok) {
            throw new Error('URL del archivo no válida');
        }

        const contentLength = fileResponse.headers.get('content-length');

        // Stream de descarga
        const downloadStream = await fetch(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            agent: httpsAgent
        });

        // Configurar subida a Archive.org
        const uploadResponse = await fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
            method: 'PUT',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`,
                'Content-Type': 'video/mp4',
                'Content-Length': contentLength,
                'x-archive-queue-derive': '0',
                'x-archive-auto-make-bucket': '1',
                'x-archive-meta-mediatype': 'movies',
                'x-archive-size-hint': contentLength
            },
            body: downloadStream.body,
            agent: httpsAgent
        });

        if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text();
            throw new Error(`Error al agregar archivo: ${errorText}`);
        }

        // Esperar procesamiento inicial
        await new Promise(resolve => setTimeout(resolve, 5000));

        res.json({
            success: true,
            message: 'Archivo agregado correctamente'
        });
    } catch (error) {
        console.error('Error al agregar archivo:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Obtener lista de archivos del usuario
app.get('/api/files', authenticateSession, async (req, res) => {
    try {
        const { accessKey, username } = req.user;

        // Búsqueda por Access Key (S3)
        const s3SearchUrl = `https://archive.org/advancedsearch.php?q=uploader:(${encodeURIComponent(accessKey)})&fl[]=identifier,title,description,collection,addeddate,uploader,source,creator,name&sort[]=addeddate+desc&output=json&rows=1000`;
        
        // Búsqueda por nombre de usuario
        const userSearchUrl = `https://archive.org/advancedsearch.php?q=uploader:(${encodeURIComponent(username)})&fl[]=identifier,title,description,collection,addeddate,uploader,source,creator,name&sort[]=addeddate+desc&output=json&rows=1000`;

        const [s3Results, userResults] = await Promise.all([
            fetch(s3SearchUrl).then(r => r.json()),
            fetch(userSearchUrl).then(r => r.json())
        ]);

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
            files: uniqueItems
        });
    } catch (error) {
        console.error('Error al obtener archivos:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Manejo de errores global
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Iniciar servidor
app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
    console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
});

// Limpieza periódica de sesiones antiguas
setInterval(() => {
    const now = Date.now();
    sessions.forEach((session, id) => {
        if (now - session.timestamp > SESSION_DURATION) {
            sessions.delete(id);
        }
    });
}, 60 * 60 * 1000); // Cada hora

function generateSessionId() {
    return Math.random().toString(36).substring(7);
}

