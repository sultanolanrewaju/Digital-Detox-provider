import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { Boom } from '@hapi/boom';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let sock;
const ALLOWED_JIDS = [];

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    // Fetch the latest compatible WhatsApp web version to prevent handshake rejection
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['Chrome', 'Desktop', '110.0.5481.177'] // Stable browser profile string
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- SCAN THIS NEW QR CODE WITH YOUR SECONDARY WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            console.log('\n================================================');
            console.log(' SUCCESS! Connected to WhatsApp cleanly.');
            console.log('================================================\n');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const chatId = msg.key.remoteJid;
            const senderName = msg.pushName || "Unknown";
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "[Media/Other Content]";
            const isFromMe = msg.key.fromMe;

            console.log(`[INCOMING MESSAGE] From JID: ${chatId} | Text: ${text}`);

            if (ALLOWED_JIDS.length === 0 || ALLOWED_JIDS.includes(chatId)) {
                io.emit('new_message', {
                    chatId,
                    senderName,
                    text,
                    isFromMe,
                    timestamp: new Date().toLocaleTimeString()
                });
            }
        }
    });
}

app.post('/api/send', async (req, res) => {
    const { chatId, message } = req.body;
    if (!sock || !chatId || !message) {
        return res.status(400).json({ error: "Missing required fields or socket not ready" });
    }
    try {
        await sock.sendMessage(chatId, { text: message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

server.listen(4000, () => {
    console.log('Backend running on http://localhost:4000');
    startWhatsApp();
});