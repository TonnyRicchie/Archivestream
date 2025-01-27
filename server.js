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
const AWS = require('aws-sdk');
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

// Configuración de CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
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

// Ruta de prueba
app.get('/test', (req, res) => {
    res.json({ status: 'Backend funcionando correctamente' });
});

// Validar credenciales
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

            // Guardar sesión
            const sessionId = Math.random().toString(36).substring(7);
            sessions.set(sessionId, { accessKey, secretKey, username });

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

// Subir archivo
app.post('/api/upload', async (req, res) => {
    try {
        const { fileUrl, title, description, collection, sessionId } = req.body;

        // Validar sesión
        const session = sessions.get(sessionId);
        if (!session) {
            throw new Error('Sesión inválida');
        }

        const { accessKey, secretKey } = session;

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
        const fileName = path.basename(fileUrl).split('?')[0] || 'video.mp4';
        const identifier = `${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;

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

// Verificar estado de procesamiento
app.get('/api/status/:identifier', async (req, res) => {
    try {
        const { identifier } = req.params;
        const response = await fetch(`https://archive.org/metadata/${identifier}`, {
            agent: httpsAgent,
            timeout: 10000
        });
        
        if (!response.ok) {
            throw new Error('Error al obtener estado');
        }

        const data = await response.json();
        
        res.json({
            success: true,
            status: data.metadata?.status || 'processing',
            files: data.files || [],
            metadata: data.metadata || {}
        });
    } catch (error) {
        console.error('Error al verificar estado:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Obtener colecciones disponibles
app.get('/api/collections', async (req, res) => {
    try {
        const response = await fetch('https://archive.org/advancedsearch.php?q=mediatype:collection&fl[]=identifier,title&sort[]=downloads+desc&output=json&rows=100', {
            agent: httpsAgent,
            timeout: 10000
        });
        
        if (!response.ok) {
            throw new Error('Error al obtener colecciones');
        }

        const data = await response.json();
        res.json({
            success: true,
            collections: data.response.docs || []
        });
    } catch (error) {
        console.error('Error al obtener colecciones:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Cerrar sesión
app.post('/api/logout', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId && sessions.has(sessionId)) {
        sessions.delete(sessionId);
        res.json({ success: true, message: 'Sesión cerrada correctamente' });
    } else {
        res.status(400).json({ success: false, message: 'Sesión no encontrada' });
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
        if (now - session.timestamp > 24 * 60 * 60 * 1000) { // 24 horas
            sessions.delete(id);
        }
    });
}, 60 * 60 * 1000); // Cada hora
