const Node = require('./node');

// Mostrar guia de uso y salir del programa
function printUsageAndExit() {
    console.log('Uso: node peer.js --port <puerto> --file <rutaArchivo> [--peer <host:puerto>]');
    console.log('Ejemplo (iniciar seed): node peer.js --port 6881 --file "/ruta/al/archivo.ext"');
    console.log('Ejemplo (iniciar peer leecher): node peer.js --port 6882 --file "/ruta/de/salida.ext" --peer 127.0.0.1:6881');
    process.exit(1);
}

// Procesar argumentos de línea de comandos
const args = process.argv.slice(2);
let port = null;
let filePath = null;
let peerAddress = null;
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && i + 1 < args.length) {
        port = parseInt(args[i+1], 10);
        i++;
    } else if (arg === '--file' && i + 1 < args.length) {
        filePath = args[i+1];
        i++;
    } else if (arg === '--peer' && i + 1 < args.length) {
        peerAddress = args[i+1];
        i++;
    } else {
        // argumento erroneo
        printUsageAndExit();
    }
}

// Validar argumentos obligatorios
if (!port || !filePath) printUsageAndExit();

// Si se pasa la direccion del peer entonces dividimos el host y puerto
let peerHost = null;
let peerPort = null;
if (peerAddress) {
    const sepIndex = peerAddress.lastIndexOf(':');
    if (sepIndex === -1) {
        console.error('Formato de --peer inválido. Use host:puerto');
        process.exit(1);
    }
    peerHost = peerAddress.substring(0, sepIndex);
    peerPort = parseInt(peerAddress.substring(sepIndex+1), 10);
    if (!peerPort) {
        console.error('Formato de --peer inválido. Puerto no válido.');
        process.exit(1);
    }
}

// Crear e iniciar el nodo P2P
const node = new Node({ port: port, filePath: filePath });
node.startListening();

// Si se especificó un peer inicial, conectarse a él
if (peerHost && peerPort) {
    console.log(`Conectando con peer inicial ${peerHost}:${peerPort}...`);
    node.connectToPeer(peerHost, peerPort);
} else {
    if (!node.isSeed) {
        console.log('Advertencia: Este nodo no tiene el archivo y ningún peer inicial fue proporcionado. El nodo esperará a que algún seed se conecte.');
    }
}
