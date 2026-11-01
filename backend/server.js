import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Or restrict to your frontend Vercel URL later
        methods: ["GET", "POST"]
    }
});

let sock;
let latestQR = '';

// Allowed JIDs filter (Add your school group JID or specific contact JIDs here)
const ALLOWED_JIDS = [
    // "120363040123456789@g.us",
];

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false // We use browser web-view or terminal fallback
    });

    sock.io?.on('connection.update', saveCreds);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            console.log('\n--- QR RECEIVED. VIEW IT AT: https://<your-render-url>/qr ---\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                startWhatsApp();
            }
        } else if (connection === 'open') {
            latestQR = ''; // Clear QR once successfully linked
            console.log('\n================================================');
            console.log(' SUCCESS! Connected to WhatsApp cleanly.');
            console.log('================================================\n');
        }
    });

    // Handle Incoming Messages & Pipe to Frontend via Socket.io
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const chatId = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;

            // Optional: Filter by allowed JIDs if you want strict notification isolation
            // if (ALLOWED_JIDS.length > 0 && !ALLOWED_JIDS.includes(chatId)) continue;

            // Extract message text safely across different content types
            const messageText = 
                msg.message.conversation || 
                msg.message.extendedTextMessage?.text || 
                msg.message.imageMessage?.caption || 
                '[Media/Other Content]';

            // Extract Sender Name
            const senderName = msg.pushName || (isFromMe ? 'Me' : 'Unknown');

            const payload = {
                chatId,
                senderName,
                text: messageText,
                isFromMe,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            console.log(`[INCOMING] From: ${chatId} (${senderName}) | Text: ${messageText}`);

            // Broadcast real-time message to your React frontend via Socket.io
            io.emit('new_message', payload);
        }
    });
}

// REST Endpoint to send messages out from your React Frontend
app.post('/api/send', async (req, res) => {
    const { chatId, message } = req.body;

    if (!chatId || !message) {
        return res.status(400).json({ error: 'Missing chatId or message' });
    }

    try {
        await sock.sendMessage(chatId, { text: message });
        res.json({ success: true, status: 'Message sent successfully' });
    } catch (err) {
        console.error('Failed to send message:', err);
        res.status(500).json({ error: 'Failed to send message', details: err.message });
    }
});

// Web Route to view crisp, scannable QR code on your phone/browser
app.get('/', async (req, res) => {
    if (!latestQR) {
        return res.send(`
            <div style="text-align:center; margin-top:50px; font-family:sans-serif;">
                <h2>WhatsApp Status: Connected or Waiting</h2>
                <p>No active QR code needed right now. If your session is valid, you're good to go!</p>
            </div>
        `);
    }
    try {
        const urlImage = await QRCode.toDataURL(latestQR);
        res.send(`
            <div style="text-align:center; margin-top:50px; font-family:sans-serif; background-color:#0f172a; color:#f8fafc; padding:40px; border-radius:12px; max-width:400px; margin:50px auto;">
                <h2>Scan WhatsApp QR Code</h2>
                <p style="color:#94a3b8; font-size:0.9rem;">Open WhatsApp on your secondary phone and scan this code:</p>
                <img src="${urlImage}" alt="WhatsApp QR Code" style="width:280px; height:280px; border:8px solid white; border-radius:8px; margin-top:15px;" />
            </div>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR image');
    }
});

// Health check root route
app.get('/', (req, res) => {
    res.send('MERN WhatsApp Focus Bridge Backend is running!');
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
    startWhatsApp();
});