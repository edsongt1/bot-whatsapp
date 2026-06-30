const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Servir o frontend (se existir a pasta dist)
const frontendDist = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
}

const uploadsDir = path.join(__dirname, 'uploads');
const sessionsDir = path.join(__dirname, 'sessions');
fs.ensureDirSync(uploadsDir);
fs.ensureDirSync(sessionsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage });

let sock = null;
let qrCodeData = null;
let currentStatus = 'disconnected';
let autoReplies = [];
let messageHistory = [];

const loadAutoReplies = () => {
  const repliesPath = path.join(__dirname, 'data', 'auto-replies.json');
  if (fs.existsSync(repliesPath)) {
    autoReplies = JSON.parse(fs.readFileSync(repliesPath, 'utf8'));
  }
};

const saveAutoReplies = () => {
  const dataDir = path.join(__dirname, 'data');
  fs.ensureDirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'auto-replies.json'), JSON.stringify(autoReplies, null, 2));
};

const startWhatsApp = async () => {
  console.log('🔄 Iniciando conexão WhatsApp...');
  
  const { state, saveCreds } = await useMultiFileAuthState(sessionsDir);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr } = update;
    console.log('📱 Status:', connection);
    
    if (qr) {
      console.log('📱 QR Code gerado!');
      qrcode.toDataURL(qr).then(url => {
        qrCodeData = url;
        currentStatus = 'qr';
      });
    }

    if (connection === 'close') {
      console.log('❌ Desconectado');
      currentStatus = 'disconnected';
      qrCodeData = null;
    } else if (connection === 'open') {
      console.log('✅ Conectado!');
      currentStatus = 'connected';
      qrCodeData = null;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.key.fromMe && m.type === 'notify') {
      const remoteJid = message.key.remoteJid;
      const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
      
      console.log('📨 Mensagem recebida:', text);
      
      messageHistory.unshift({
        id: Date.now(),
        from: remoteJid,
        text: text,
        timestamp: new Date().toISOString(),
        type: 'received'
      });
      
      if (messageHistory.length > 100) messageHistory.pop();

      for (const reply of autoReplies) {
        if (reply.enabled && (reply.trigger === '*' || text.toLowerCase().includes(reply.trigger.toLowerCase()))) {
          try {
            console.log('↩️ Enviando resposta automática');
            if (reply.messageType === 'text') {
              await sock.sendMessage(remoteJid, { text: reply.content });
            } else if (reply.messageType === 'image') {
              const imgUrl = `http://localhost:${PORT}${reply.content}`;
              await sock.sendMessage(remoteJid, {
                image: { url: imgUrl },
                caption: reply.description || ''
              });
            } else if (reply.messageType === 'video') {
              const vidUrl = `http://localhost:${PORT}${reply.content}`;
              await sock.sendMessage(remoteJid, {
                video: { url: vidUrl },
                caption: reply.description || ''
              });
            }
          } catch (err) {
            console.error('❌ Erro ao enviar:', err);
          }
          break;
        }
      }
    }
  });
};

loadAutoReplies();
startWhatsApp();

app.get('/api/status', (req, res) => {
  res.json({ status: currentStatus, qrCode: qrCodeData });
});

app.post('/api/reconnect', async (req, res) => {
  console.log('🔄 Reiniciando conexão...');
  
  try {
    if (sock && sock.ws) {
      sock.ws.close();
    }
  } catch (e) {}
  
  sock = null;
  qrCodeData = null;
  currentStatus = 'disconnected';
  
  try {
    await startWhatsApp();
  } catch (e) {
    console.error('❌ Erro:', e);
  }
  
  res.json({ success: true });
});

app.get('/api/auto-replies', (req, res) => {
  res.json(autoReplies);
});

app.post('/api/auto-replies', (req, res) => {
  const reply = { id: Date.now(), ...req.body, enabled: true };
  autoReplies.push(reply);
  saveAutoReplies();
  res.json(reply);
});

app.put('/api/auto-replies/:id', (req, res) => {
  const index = autoReplies.findIndex(r => r.id === parseInt(req.params.id));
  if (index !== -1) {
    autoReplies[index] = { ...autoReplies[index], ...req.body };
    saveAutoReplies();
    res.json(autoReplies[index]);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.delete('/api/auto-replies/:id', (req, res) => {
  autoReplies = autoReplies.filter(r => r.id !== parseInt(req.params.id));
  saveAutoReplies();
  res.json({ success: true });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  res.json({ filePath: '/uploads/' + req.file.filename });
});

app.post('/api/send-message', async (req, res) => {
  if (!sock || currentStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  const { number, message, messageType, filePath, description } = req.body;
  const jid = number + '@s.whatsapp.net';
  try {
    if (messageType === 'text') {
      await sock.sendMessage(jid, { text: message });
    } else if (messageType === 'image') {
      const imgUrl = `http://localhost:${PORT}${filePath}`;
      await sock.sendMessage(jid, { image: { url: imgUrl }, caption: description || '' });
    } else if (messageType === 'video') {
      const vidUrl = `http://localhost:${PORT}${filePath}`;
      await sock.sendMessage(jid, { video: { url: vidUrl }, caption: description || '' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-bulk', async (req, res) => {
  if (!sock || currentStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  const { numbers, message, messageType, filePath, description, delay } = req.body;
  const sendAll = async () => {
    for (let i = 0; i < numbers.length; i++) {
      const jid = numbers[i] + '@s.whatsapp.net';
      try {
        if (messageType === 'text') {
          await sock.sendMessage(jid, { text: message });
        } else if (messageType === 'image') {
          const imgUrl = `http://localhost:${PORT}${filePath}`;
          await sock.sendMessage(jid, { image: { url: imgUrl }, caption: description || '' });
        } else if (messageType === 'video') {
          const vidUrl = `http://localhost:${PORT}${filePath}`;
          await sock.sendMessage(jid, { video: { url: vidUrl }, caption: description || '' });
        }
      } catch (err) {
        console.error('❌ Falha:', err);
      }
      if (i < numbers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  };
  sendAll();
  res.json({ success: true });
});

app.get('/api/history', (req, res) => {
  res.json(messageHistory);
});

// Rota padrão para servir o frontend
if (fs.existsSync(frontendDist)) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log('✅ Servidor na porta', PORT);
  console.log('📱 Acesse: http://localhost:' + PORT);
});
