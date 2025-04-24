// Manager.js - Módulo para manejo de archivo y piezas en el sistema P2P
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

class Manager {
    constructor(filePath, mode, pieceSize) {
        this.filePath = filePath;                          // Ruta del archivo a leer/escribir
        this.pieceSize = pieceSize;                        // Tamaño de pieza en bytes
        this.fileHandle = null;                            // Manejador de archivo (FileHandle) de Node.js
        this.fileSize = 0;                                 // Tamaño total del archivo en bytes
        this.mode = mode;                                  // Modo de apertura: 'r' (solo lectura) o 'w+' (lectura/escritura)
    }

    async openFile() {
        // Abrir el archivo según el modo especificado.
        // 'r' para leer (archivo existente), 'w+' para leer/escribir (crea archivo si no existe, trunca si existe).
        this.fileHandle = await fsp.open(this.filePath, this.mode);
        if (this.mode === 'r') {
            // Si es modo lectura, obtener tamaño del archivo existente
            const stats = await this.fileHandle.stat();
            this.fileSize = stats.size;
        } else {
            // Si es modo escritura/lectura, inicialmente tamaño 0; 
            // se establecerá más adelante cuando sepamos el tamaño del archivo esperado.
            this.fileSize = 0;
        }
    }

    async setSize(size) {
        // Establece el tamaño del archivo (usado en modo 'w+' cuando se conoce el tamaño total esperado).
        this.fileSize = size;
        await this.fileHandle.truncate(size);  // Ajusta el tamaño del archivo (rellena con ceros si es más grande que actual).
    }

    async readPiece(index) {
        // Lee una pieza del archivo dada por su índice (0 basado).
        // Calcula la posición y el tamaño de la pieza a leer.
        const offset = index * this.pieceSize;                         // Posición de inicio en el archivo
        let length = this.pieceSize;                                   // Por defecto leer un bloque del tamaño de pieza
        if (offset + length > this.fileSize) {
            // Si la última pieza es más pequeña que el tamaño de pieza estándar, ajustar longitud
            length = this.fileSize - offset;
        }
        const buffer = Buffer.alloc(length);                           // Buffer para almacenar los datos de la pieza
        await this.fileHandle.read(buffer, 0, length, offset);         // Leer datos desde el archivo en la posición especificada
        return buffer;                                                 // Devolver el buffer con los datos de la pieza
    }

    async writePiece(index, dataBuffer) {
        // Escribe una pieza en el archivo en la posición correspondiente al índice.
        const offset = index * this.pieceSize;                         // Calcular la posición de inicio en el archivo
        await this.fileHandle.write(dataBuffer, 0, dataBuffer.length, offset); // Escribir el buffer en el archivo en la posición calculada
    }

    async computeHash() {
        // Calcula el hash SHA-1 del archivo completo. Devuelve una cadena hexadecimal con el hash.
        return new Promise((resolve, reject) => {
            // Crear un hash de tipo SHA-1
            const hash = crypto.createHash('sha1');
            // Crear un stream de lectura desde el archivo
            const stream = fs.createReadStream(this.filePath);
            stream.on('data', chunk => {
                hash.update(chunk);      // Actualizar hash con cada fragmento de datos
            });
            stream.on('end', () => {
                const result = hash.digest('hex'); // Calcular hash final en formato hexadecimal
                resolve(result);         // Resolver la promesa con el resultado
            });
            stream.on('error', err => {
                reject(err);             // Rechazar la promesa en caso de error de lectura
            });
        });
    }

    async close() {
        // Cierra el archivo (libera el descriptor). 
        if (this.fileHandle) {
            await this.fileHandle.close();
            this.fileHandle = null;
        }
    }
}

module.exports = Manager;
