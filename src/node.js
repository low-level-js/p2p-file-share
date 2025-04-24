// Node.js - Lógica principal de la red P2P (manejo de conexiones, protocolo y compartición de archivos)
const net = require('net');
const crypto = require('crypto');
const Manager = require('./manager');

class Node {
    constructor(options) {
        this.port = options.port;                            // Puerto TCP para escuchar conexiones
        this.filePath = options.filePath;                    // Ruta del archivo (para seeder, archivo existente; para leecher, ruta destino)
        this.fileName = null;                                // Nombre de archivo (obtenido del path o de la metadata del peer)
        this.fileSize = null;                                // Tamaño del archivo en bytes
        this.fileHash = null;                                // Hash SHA-1 del archivo (identificador del contenido)
        this.pieceSize = 65536;                              // Tamaño de cada pieza en bytes (64 KiB por defecto)
        this.numPieces = null;                               // Número total de piezas en que se divide el archivo
        this.id = crypto.randomBytes(8).toString('hex');     // ID único del peer (16 caracteres hexadecimales)
        this.knownPeers = new Map();                         // Lista de peers conocidos (clave: peer ID, valor: info del peer)
        this.fileManager = null;                             // Administrador de archivo para lectura/escritura de piezas
        this.havePieces = new Set();                         // Conjunto de índices de piezas que este nodo ya tiene
        this.missingPieces = new Set();                      // Conjunto de índices de piezas que faltan por descargar
        this.pendingPieces = new Set();                      // Conjunto de índices de piezas solicitadas en curso (pendientes de recibir)
        this.server = null;                                  // Servidor TCP (para aceptar conexiones entrantes)
        this.started = false;                                // Indica si el nodo ya inició (escuchando)
        this.progressInterval = null;                        // Intervalo para mostrar progreso por consola
        this.startTime = null;                               // Momento de inicio de la descarga (para cálculo de velocidad)
        this.isSeed = false;                                 // Indica si este nodo inicia con el archivo completo (seeder)

        // Verifica si el archivo existe localmente para definir seeder o leecher
        const fs = require('fs');

        // Si el archivo ya existe, asumimos que este nodo es un seeder (tiene el archivo completo).
        if (fs.existsSync(this.filePath)) this.isSeed = true;

        // Obtenemos el nombre de archivo (parte final del path)
        this.fileName = require('path').basename(this.filePath);

        // Inicializamos Manager ya sea seeder o leecher
        const mode = this.isSeed ? 'r' : 'w+';               // 'r' para leer (seed), 'w+' para escribir (leecher)
        this.fileManager = new Manager(this.filePath, mode, this.pieceSize);
        // Abrir el archivo (sin bloqueo; en caso de leecher, crea archivo vacío; en caso de seed, abre existente)
        this.fileManager.openFile().then(async () => {
            if (this.isSeed) {
                // Si es seeder, obtenemos el tamaño del archivo y podemos calcular número de piezas
                this.fileSize = this.fileManager.fileSize;
                // Si el archivo es más pequeño que el tamaño de pieza, ajustar el tamaño de pieza para que numPieces = 1
                if (this.fileSize < this.pieceSize) {
                    this.pieceSize = this.fileSize;
                    this.fileManager.pieceSize = this.fileSize;
                }
                // Calcular número de piezas
                this.numPieces = Math.ceil(this.fileSize / this.pieceSize);
                // Marcar todas las piezas como disponibles (el seeder las tiene todas)
                for (let i = 0; i < this.numPieces; i++) {
                    this.havePieces.add(i);
                }
                // Calcular hash SHA-1 del archivo para identificarlo (infohash)
                try {
                    this.fileHash = await this.fileManager.computeHash();
                } catch (err) {
                    console.error('Error calculando hash del archivo:', err);
                    process.exit(1);
                }
            }
        }).catch(err => {
            console.error('Error abriendo el archivo:', err);
            process.exit(1);
        });
    }

    startListening() {
        // Inicia el servidor TCP para aceptar conexiones entrantes de otros peers.
        if (this.started) return;
        this.server = net.createServer(socket => {
            // Nuevo peer conectado entrante (socket aceptado)
            socket.setEncoding('utf8');                   // Interpretar datos entrantes como texto UTF-8
            socket.peerId = null;                         // Aún no conocemos el ID del peer remoto (hasta handshake)
            socket.isOutgoing = false;                    // Indica que esta conexión fue iniciada por el remoto (no por nosotros)
            socket.buffer = '';                           // Buffer temporal para datos entrantes sin procesar
            // Adjuntar manejadores de eventos para el socket
            this._setupSocketHandlers(socket);
        });
        // Manejar error del servidor
        this.server.on('error', err => {
            console.error('Error en el servidor P2P:', err);
        });
        // Comenzar a escuchar en el puerto especificado
        this.server.listen(this.port, () => {
            this.started = true;
            console.log(`Nodo P2P iniciado. ID: ${this.id}, escuchando en puerto ${this.port}.`);
            if (this.isSeed) {
                console.log(`Archivo disponible para compartir: "${this.fileName}" (${this.fileSize} bytes). Esperando conexiones de pares...`);
            }
        });
    }

    connectToPeer(host, port) {
        // Establece una conexión saliente a otro peer conocido por su dirección y puerto.
        const socket = net.connect(port, host, () => {
            // Conexión establecida con el peer remoto
            socket.setEncoding('utf8');
            socket.peerId = null;                        // Aún no se conoce el ID hasta recibir handshake de respuesta
            socket.isOutgoing = true;                    // Esta conexión fue iniciada por nosotros
            socket.buffer = '';                          // Buffer para datos entrantes
            // Agregar manejadores de eventos para este socket
            this._setupSocketHandlers(socket);
            // Enviar handshake inicial una vez conectados
            this._sendHandshake(socket);
        });
        // Manejo de errores en la conexión saliente (por ejemplo, conexión rechazada)
        socket.on('error', err => {
            console.error(`Error de conexión al peer ${host}:${port}:`, err.message);
        });
    }

    _setupSocketHandlers(socket) {
        // Configura los manejadores de datos, cierre y error de un socket de peer.
        socket.on('data', async (data) => {
            // Concatenar datos recibidos en el buffer y procesar mensaje por mensaje (delimitados por newline)
            socket.buffer += data;
            let newlineIndex;
            // Procesar todos los mensajes completos disponibles en el buffer
            while ((newlineIndex = socket.buffer.indexOf('\n')) !== -1) {
                const rawMessage = socket.buffer.slice(0, newlineIndex);
                socket.buffer = socket.buffer.slice(newlineIndex + 1);
                if (!rawMessage) continue;  // ignorar líneas vacías (por seguridad)
                let message;
                try {
                    message = JSON.parse(rawMessage);
                } catch (err) {
                    console.error('Mensaje JSON malformado recibido, descartando:', rawMessage);
                    continue;
                }
                // Manejar el mensaje según su tipo
                await this._handleMessage(socket, message);
            }
        });

        socket.on('close', () => {
            // Conexion con peer cerrada
            if (socket.peerId && this.knownPeers.has(socket.peerId)) {
                // Si teníamos conocimiento de este peer, actualizar su estado
                const peerInfo = this.knownPeers.get(socket.peerId);
                peerInfo.socket = null;
                peerInfo.busy = false;
            }
            console.log(`Conexión con peer ${socket.peerId || '(desconocido)'} cerrada.`);
            // Si alguna pieza estaba pendiente de este peer, liberarla para volver a solicitarla a otros
            // Buscar piezas pendientes que nadie más haya enviado aún (difícil de rastrear directamente).
            // Simplificación: simplemente liberamos todas las piezas pendientes (volverán a solicitarse).
            // (Esto puede reintentar piezas que estén en progreso de otros, pero evitamos complejidad de seguimiento detallado)
            this.pendingPieces.clear();
            // Re-lanzar solicitudes por si quedaron piezas sin descargar
            this._scheduleRequests();
        });

        socket.on('error', (err) => {
            // Error en la conexión con el peer
            console.error(`Error en la conexión con peer ${socket.peerId || socket.remoteAddress}:`, err.message);
        });
    }

    async _handleMessage(socket, message) {
        // Lógica para procesar mensajes entrantes dependiendo del tipo
        const msgType = message.type;
        switch (msgType) {
            case 'handshake':
                await this._handleHandshake(socket, message);
                break;
            case 'bitfield':
                this._handleBitfield(socket, message);
                break;
            case 'request':
                this._handleRequest(socket, message);
                break;
            case 'piece':
                await this._handlePiece(socket, message);
                break;
            case 'have':
                this._handleHave(socket, message);
                break;
            case 'peers':
                this._handlePeers(socket, message);
                break;
            default:
                console.warn('Tipo de mensaje desconocido recibido:', msgType);
        }
    }

    async _handleHandshake(socket, message) {
        // Procesa un mensaje de handshake entrante.
        const remoteId = message.id;
        const remoteFileName = message.fileName || null;
        const remoteFileSize = message.fileSize || null;
        const remoteFileHash = message.fileHash || null;
        const remotePieceSize = message.pieceSize || null;
        const remotePort = message.port;
        // Si recibimos handshake de un peer con nuestro mismo ID, ignorar (no debería suceder)
        if (remoteId === this.id) {
            console.warn('Recibido handshake de un peer con mismo ID que este nodo, ignorando.');
            return;
        }
        // Verificar si ya teníamos conocimiento de este peer
        let peerInfo;
        if (this.knownPeers.has(remoteId)) {
            peerInfo = this.knownPeers.get(remoteId);
            peerInfo.socket = socket;
        } else {
            // Si es un peer nuevo, agregar a lista de conocidos
            peerInfo = { id: remoteId, host: socket.remoteAddress, port: remotePort, socket: socket, availablePieces: new Set(), busy: false };
            this.knownPeers.set(remoteId, peerInfo);
        }
        // Asignar el ID al socket para referencia rápida
        socket.peerId = remoteId;

        // Manejo de identificación de archivo entre peers:
        if (this.isSeed) {
            // Este nodo tiene el archivo completo.
            if (remoteFileHash && this.fileHash && remoteFileHash !== this.fileHash) {
                // Si el peer remoto presenta un hash de archivo distinto, no es el mismo archivo - desconectar
                console.error('Peer conectado tiene un hash de archivo distinto. Terminando conexión.');
                socket.end();  // cerrar conexión
                this.knownPeers.delete(remoteId);
                return;
            }
            // Si el remoto no envió hash (porque quizás es leecher sin info), no hacemos nada especial.
        } else {
            // Este nodo no tiene el archivo (leecher).
            if (remoteFileHash) {
                // Si el handshake remoto incluye información del archivo, adoptarla
                this.fileName = remoteFileName;
                this.fileSize = remoteFileSize;
                this.fileHash = remoteFileHash;
                this.pieceSize = remotePieceSize;
                // Calcular número de piezas
                this.numPieces = Math.ceil(this.fileSize / this.pieceSize);
                // Inicializar piezas faltantes (todas) y disponibles (ninguna) para este leecher
                for (let i = 0; i < this.numPieces; i++) {
                    this.missingPieces.add(i);
                }
                this.havePieces = new Set();
                // Configurar FileManager con el tamaño conocido del archivo
                await this.fileManager.setSize(this.fileSize);
                console.log(`Meta de archivo recibida: "${this.fileName}" (${this.fileSize} bytes, ${this.numPieces} piezas). Iniciando descarga...`);
                // Establecer tiempo de inicio de descarga para cálculos de velocidad
                this.startTime = Date.now();
                // Iniciar visualización periódica de progreso de descarga
                this._startProgressInterval();
            } else {
                // Si ninguno tiene información del archivo, no se puede continuar
                console.error('Ninguno de los peers tiene información del archivo a compartir. Conexión terminada.');
                socket.end();
                this.knownPeers.delete(remoteId);
                return;
            }
        }

        // Tras manejar handshake entrante, enviar nuestro handshake en respuesta si no se ha enviado aún por este socket.
        // (Por ejemplo, en el caso de ser el lado servidor que recibió primero).
        if (!socket.isOutgoing && !peerInfo.handshakeSent) {
            // Somos el lado que escuchó y aún no envió handshake
            this._sendHandshake(socket);
        }

        // Marcar handshake de este peer como recibido (y completado el intercambio).
        peerInfo.handshakeReceived = true;

        // Si somos seeder o tenemos piezas, enviar bitfield con nuestras piezas disponibles
        if (this.havePieces.size > 0) {
            this._sendBitfield(socket);
        }
        
        // Compartir información de otros peers con este nuevo peer (peer exchange)
        if (!socket.isOutgoing) {
            // Enviar al peer conectado la lista de otros peers conocidos (para que pueda conectarse a ellos)
            const otherPeers = [];
            for (let [pid, pinfo] of this.knownPeers.entries()) {
                if (pid !== remoteId && pinfo.socket) {
                    otherPeers.push({ id: pid, host: pinfo.host || pinfo.socket.remoteAddress, port: pinfo.port });
                }
            }
            if (otherPeers.length > 0) {
                const peersMsg = {
                    type: 'peers',
                    peers: otherPeers
                };
                socket.write(JSON.stringify(peersMsg) + '\n');
            }
            // Avisar a los demás peers que este nuevo peer se ha unido
            const newPeerInfo = { id: remoteId, host: socket.remoteAddress, port: remotePort };
            for (let [pid, pinfo] of this.knownPeers.entries()) {
                if (pid !== remoteId && pinfo.socket) {
                    const singlePeerMsg = { type: 'peers', peers: [ newPeerInfo ] };
                    pinfo.socket.write(JSON.stringify(singlePeerMsg) + '\n');
                }
            }
        }
    }

    _handleBitfield(socket, message) {
        // Procesa un mensaje de bitfield (lista de piezas que el peer remoto posee)
        const pieces = message.pieces;
        if (!socket.peerId || !this.knownPeers.has(socket.peerId)) return;
        const peerInfo = this.knownPeers.get(socket.peerId);
        peerInfo.availablePieces = new Set(pieces);   // Actualizar las piezas disponibles de ese peer
        console.log(`Recibido mapa de piezas de peer ${socket.peerId}: ${pieces.length} piezas disponibles.`);
        // Una vez conocemos qué piezas tiene el peer, podemos intentar solicitar piezas que necesitamos.
        this._scheduleRequests();
    }

    _handleRequest(socket, message) {
        // Procesa un mensaje de solicitud de pieza entrante.
        const index = message.index;
        // Verificar si tenemos esa pieza para enviar
        if (!this.havePieces.has(index)) {
            // Si por alguna razón no la tenemos (solicitud inválida), se ignora
            console.warn(`Peer ${socket.peerId} solicitó pieza ${index} que no tenemos.`);
            return;
        }
        // Leer los datos de la pieza desde el archivo
        this.fileManager.readPiece(index).then(buffer => {
            // Enviar el mensaje de pieza con datos en base64
            const pieceMsg = {
                type: 'piece',
                index: index,
                data: buffer.toString('base64')
            };
            socket.write(JSON.stringify(pieceMsg) + '\n');
        }).catch(err => {
            console.error(`Error al leer pieza ${index} para enviar a peer ${socket.peerId}:`, err);
        });
    }

    async _handlePiece(socket, message) {
        // Procesa un mensaje de pieza recibida (datos de una pieza solicitada)
        const index = message.index;
        const dataBase64 = message.data;
        // Decodificar los datos de base64 a un buffer de bytes
        const dataBuffer = Buffer.from(dataBase64, 'base64');
        // Escribir los datos en el archivo local
        try {
            await this.fileManager.writePiece(index, dataBuffer);
        } catch (err) {
            console.error(`Error escribiendo la pieza ${index} en el archivo local:`, err);
            return;
        }
        // Actualizar nuestras estructuras de seguimiento de piezas
        this.havePieces.add(index);
        this.missingPieces.delete(index);
        this.pendingPieces.delete(index);
        // Marcar al peer como libre para recibir otra solicitud
        if (socket.peerId && this.knownPeers.has(socket.peerId)) {
            this.knownPeers.get(socket.peerId).busy = false;
        }
        // Incrementar contador de bytes descargados
        if (!this.bytesDownloaded) this.bytesDownloaded = 0;
        this.bytesDownloaded += dataBuffer.length;
        // Notificar a todos los demás peers que ahora tenemos esta pieza (mensaje 'have')
        const haveMsg = {
            type: 'have',
            index: index
        };
        for (let [peerId, peer] of this.knownPeers.entries()) {
            if (peer.socket && peerId !== socket.peerId) {
                peer.socket.write(JSON.stringify(haveMsg) + '\n');
            }
        }
        console.log(`Pieza ${index} recibida (${dataBuffer.length} bytes). Piezas restantes: ${this.missingPieces.size}.`);
        // Verificar si la descarga se completó
        if (this.missingPieces.size === 0) {
            // Descarga terminada
            console.log(`¡Descarga completada! Archivo "${this.fileName}" descargado completamente.`);
            // Detener intervalo de progreso
            if (this.progressInterval) {
                clearInterval(this.progressInterval);
                this.progressInterval = null;
            }
            // Verificar integridad del archivo comparando hash (si tenemos el hash esperado)
            if (this.fileHash) {
                try {
                    const downloadedHash = await this.fileManager.computeHash();
                    if (downloadedHash === this.fileHash) {
                        console.log('Verificación de integridad: OK (hash coincide).');
                    } else {
                        console.warn('Advertencia: el hash del archivo descargado difiere del esperado. El archivo podría estar corrupto.');
                    }
                } catch (err) {
                    console.error('No se pudo verificar el hash del archivo descargado:', err);
                }
            }
            console.log('El nodo continuará corriendo como seed para compartir el archivo con otros peers.');
            // Marcar estado como seeder a partir de ahora
            this.isSeed = true;
            // Actualizar bitfield (todas las piezas disponibles ahora)
            // Ya tenemos havePieces completo, no hace falta enviar bitfield a conectados (les fuimos enviando 'have').
            return;
        }
        // Si aún faltan piezas, solicitar la siguiente disponible
        this._scheduleRequests();
    }

    _handleHave(socket, message) {
        // Procesa un mensaje 'have' indicando que un peer obtuvo una nueva pieza.
        const index = message.index;
        if (!socket.peerId || !this.knownPeers.has(socket.peerId)) return;
        const peerInfo = this.knownPeers.get(socket.peerId);
        peerInfo.availablePieces.add(index);
        console.log(`Peer ${socket.peerId} ha obtenido la pieza ${index}.`);
        // Si nosotros aún no tenemos esa pieza y no está siendo solicitada, podríamos solicitarla a ese peer.
        if (this.missingPieces.has(index) && !this.pendingPieces.has(index) && !peerInfo.busy) {
            // Si el peer no está ocupado y tiene una pieza que necesitamos, intentar pedirla
            this._scheduleRequests();
        }
    }

    _handlePeers(socket, message) {
        // Procesa un mensaje 'peers' que contiene lista de peers adicionales conocidos por el remitente.
        const peersList = message.peers;  // Array de objetos {id, host, port}
        for (let peer of peersList) {
            const { id: peerId, host, port } = peer;
            if (peerId === this.id) continue;                // ignorar si es nuestro propio ID
            if (!this.knownPeers.has(peerId)) {
                // Agregar peer nuevo a la lista conocida
                this.knownPeers.set(peerId, { id: peerId, host: host, port: port, socket: null, availablePieces: new Set(), busy: false });
                // Aplicar regla de conexión: solo iniciar conexión si nuestro ID es mayor para evitar duplicados
                if (this._shouldInitiateConnection(peerId)) {
                    console.log(`Descubierto peer ${peerId} en ${host}:${port}, iniciando conexión...`);
                    this.connectToPeer(host, port);
                } else {
                    // Si no debemos iniciar, esperamos a que el peer inicie conexión (regla de prevenir colisión).
                    console.log(`Descubierto peer ${peerId}. Esperando a que el peer inicie conexión (regla de prevenir colisión).`);
                }
            }
        }
    }

    _sendHandshake(socket) {
        // Envía un mensaje de handshake por el socket proporcionado, incluyendo metadatos del archivo.
        const handshakeMsg = {
            type: 'handshake',
            id: this.id,
            fileName: this.fileName,
            fileSize: this.fileSize,
            fileHash: this.fileHash,
            pieceSize: this.pieceSize,
            port: this.port
        };
        socket.write(JSON.stringify(handshakeMsg) + '\n');
        // Marcar que ya enviamos nuestro handshake en esta conexión
        if (socket.peerId && this.knownPeers.has(socket.peerId)) {
            this.knownPeers.get(socket.peerId).handshakeSent = true;
        }
    }

    _sendBitfield(socket) {
        // Envía un mensaje de bitfield indicando qué piezas posee este nodo.
        const piecesArray = Array.from(this.havePieces);
        const bitfieldMsg = {
            type: 'bitfield',
            pieces: piecesArray
        };
        socket.write(JSON.stringify(bitfieldMsg) + '\n');
    }

    _sendRequest(socket, index) {
        // Envía una solicitud de pieza específica a un peer.
        const requestMsg = {
            type: 'request',
            index: index
        };
        if (socket) {
            this.pendingPieces.add(index);
            if (socket.peerId && this.knownPeers.has(socket.peerId)) {
                this.knownPeers.get(socket.peerId).busy = true;
            }
            socket.write(JSON.stringify(requestMsg) + '\n');
            console.log(`Solicitando pieza ${index} al peer ${socket.peerId}.`);
        }
    }

    _scheduleRequests() {
        // Intenta asignar solicitudes de piezas faltantes a peers disponibles.
        if (!this.fileHash || this.missingPieces.size === 0) {
            // Si no hay información de archivo o no faltan piezas, no hacer nada.
            return;
        }
        for (let [peerId, peerInfo] of this.knownPeers.entries()) {
            if (!peerInfo.socket) continue;                      // Saltar peers no conectados
            if (peerInfo.busy) continue;                         // Saltar peers que ya están atendiendo una solicitud nuestra
            // Encontrar una pieza que el peer tenga y que nosotros necesitemos
            for (let pieceIndex of peerInfo.availablePieces) {
                if (this.missingPieces.has(pieceIndex) && !this.pendingPieces.has(pieceIndex)) {
                    // Asignar esta pieza a este peer
                    this._sendRequest(peerInfo.socket, pieceIndex);
                    break; // salir del loop de piezas para no asignar más de una a este peer a la vez
                }
            }
        }
    }

    _shouldInitiateConnection(otherPeerId) {
        // Aplica la regla para prevenir conexiones duplicadas.
        // Devuelve true si este nodo debería iniciar la conexión hacia el otro peer dado su ID.
        // Regla adoptada: el peer con ID más alto inicia la conexión.
        return (otherPeerId && this.id && this.id > otherPeerId);
    }

    _startProgressInterval() {
        // Inicia un intervalo para mostrar periódicamente el estado de la descarga (nombre, porcentaje, velocidad, etc).
        if (this.progressInterval) return;
        this.progressInterval = setInterval(() => {
            if (!this.fileSize) return;
            const bytesDone = this.fileSize - (this.missingPieces.size * this.pieceSize);
            const percent = ((bytesDone / this.fileSize) * 100).toFixed(2);
            let speedStr = '';
            if (this.startTime) {
                const elapsed = (Date.now() - this.startTime) / 1000;
                if (elapsed > 0) {
                    const speed = bytesDone / elapsed; // bytes por segundo (promedio)
                    const speedKB = speed / 1024;
                    speedStr = `Velocidad: ${speedKB.toFixed(1)} KB/s`;
                }
            }
            console.log(`Progreso: ${percent}% (${bytesDone}/${this.fileSize} bytes). ${speedStr}`);
        }, 1000);
    }
}

module.exports = Node;
