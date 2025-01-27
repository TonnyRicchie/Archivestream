olve => setTimeout(resolve, 5000));
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

wss.on('connection', (ws) => {
    console.log('Nueva conexión WebSocket');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'subscribe' && data.sessionId) {
                ws.sessionId = data.sessionId;
                console.log('Cliente suscrito:', data.sessionId);
            }
        } catch (error) {
            console.error('Error al procesar mensaje:', error);
        }
    });

    ws.on('error', (error) => {
        console.error('Error en conexión WebSocket:', error);
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
app.put('/api/metadata/:identifier', async (req, res    const { identifier } = req.params;
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
