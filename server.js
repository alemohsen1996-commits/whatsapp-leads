const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => console.error('Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Rejection:', reason));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data', 'data.json');
const PORT = process.env.PORT || 3000;
const ASSIGNMENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ======= السيرفر بيشتغل أول =======
app.listen(PORT, () => {
  console.log(`🚀 السيرفر شغال على PORT ${PORT}`);
  setTimeout(() => initWhatsApp(), 3000);
});

// ======= البيانات =======
function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadData() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return { team: [], currentIndex: 0, assignments: {}, leads: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { team: [], currentIndex: 0, assignments: {}, leads: [] }; }
}
function saveData(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ======= واتساب =======
let isReady = false;
let pairingCode = null;
let pairingPhone = null;
let client = null;
let isInitializing = false;

function initWhatsApp() {
  if (isInitializing) return;
  isInitializing = true;
  console.log('⏳ جاري تشغيل واتساب...');

  try {
    client = new Client({
      authStrategy: new LocalAuth({ dataPath: path.join(__dirname, 'data', '.wwebjs_auth') }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--mute-audio',
          '--disable-features=IsolateOrigins,site-per-process',
          '--js-flags=--max-old-space-size=128',
        ]
      }
    });

    client.on('qr', async () => {
      // لو فيه رقم محفوظ، اطلب pairing code بدل QR
      const data = loadData();
      const phone = data.settings?.pairingPhone;
      if (phone) {
        try {
          console.log(`📱 بطلب pairing code للرقم: ${phone}`);
          const code = await client.requestPairingCode(phone);
          pairingCode = code;
          pairingPhone = phone;
          console.log(`✅ الكود: ${code}`);
        } catch (e) {
          console.error('فشل طلب الكود:', e.message);
        }
      } else {
        console.log('⚠️ مفيش رقم محفوظ - ادخل رقمك في الداشبورد');
      }
    });

    client.on('ready', () => {
      console.log('✅ واتساب متصل!');
      isReady = true;
      pairingCode = null;
      isInitializing = false;
    });

    client.on('disconnected', (reason) => {
      console.log('❌ انفصل:', reason);
      isReady = false;
      isInitializing = false;
      setTimeout(() => initWhatsApp(), 5000);
    });

    client.on('auth_failure', () => {
      console.log('❌ فشل التوثيق');
      isReady = false;
      isInitializing = false;
    });

    client.on('message', handleMessage);

    client.initialize().catch(err => {
      console.error('❌ خطأ تشغيل:', err.message);
      isInitializing = false;
      setTimeout(() => initWhatsApp(), 15000);
    });

  } catch (err) {
    console.error('❌ خطأ:', err.message);
    isInitializing = false;
    setTimeout(() => initWhatsApp(), 15000);
  }
}

async function handleMessage(msg) {
  if (msg.isGroupMsg || msg.fromMe) return;
  const phone = msg.from.replace('@c.us', '').replace(/[^0-9]/g, '');
  const body = msg.body || '';
  const timestamp = Date.now();
  console.log(`\n📩 من: +${phone}`);

  let data = loadData();
  const existing = data.assignments[phone];
  const isExpired = existing && (timestamp - existing.ts) > ASSIGNMENT_EXPIRY_MS;

  if (existing && !isExpired) {
    const salesperson = data.team.find(m => m.id === existing.salesId);
    console.log(`   🔄 رجع → ${existing.salesName}`);
    if (salesperson?.phone) {
      try {
        await client.sendMessage(salesperson.phone.replace(/[^0-9]/g, '') + '@c.us',
          `🔄 *تواصل مرة تانية*\n\n👤 العميل: *+${phone}*\n💬 الرسالة: "${body}"\n\n_ده عميلك من قبل - تابع معاه_ ✅`);
      } catch (e) { console.error('فشل الإرسال:', e.message); }
    }
    data.leads.push({ id: timestamp, phone, message: body, type: 'return', assignedId: existing.salesId, assignedName: existing.salesName, ts: timestamp });
    data.assignments[phone].lastMessage = timestamp;
    saveData(data); return;
  }

  if (!data.team.length) { console.log('⚠️ مفيش فريق'); return; }
  const idx = data.currentIndex % data.team.length;
  const member = data.team[idx];
  console.log(`   🎯 جديد → ${member.name}`);
  data.assignments[phone] = { salesId: member.id, salesName: member.name, ts: timestamp, lastMessage: timestamp };
  const m = data.team.find(x => x.id === member.id);
  if (m) m.count = (m.count || 0) + 1;
  data.currentIndex++;
  if (member.phone) {
    try {
      await client.sendMessage(member.phone.replace(/[^0-9]/g, '') + '@c.us',
        `🎯 *ليد جديد!*\n\n👤 رقم العميل: *+${phone}*\n💬 الرسالة: "${body}"\n\n_تواصل معاه دلوقتي_ 🚀`);
    } catch (e) { console.error('فشل الإرسال:', e.message); }
  }
  data.leads.push({ id: timestamp, phone, message: body, type: 'new', assignedId: member.id, assignedName: member.name, ts: timestamp });
  saveData(data);
}

// ======= API =======
app.get('/api/status', (req, res) => res.json({
  ready: isReady,
  pairingCode,
  pairingPhone,
  waiting: !isReady && !pairingCode
}));

app.get('/api/data', (req, res) => res.json(loadData()));

// طلب pairing code برقم التليفون
app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'الرقم مطلوب' });

  const data = loadData();
  if (!data.settings) data.settings = {};
  data.settings.pairingPhone = phone.replace(/[^0-9]/g, '');
  saveData(data);

  // لو العميل شغال وفي QR طور، اطلب الكود
  if (client && !isReady) {
    try {
      const code = await client.requestPairingCode(phone.replace(/[^0-9]/g, ''));
      pairingCode = code;
      pairingPhone = phone;
      console.log(`✅ كود الربط: ${code}`);
      return res.json({ ok: true, code });
    } catch (e) {
      return res.status(500).json({ error: 'فشل طلب الكود: ' + e.message });
    }
  }

  res.json({ ok: true, message: 'تم حفظ الرقم، هيظهر الكود بعد التشغيل' });
});

app.post('/api/team', (req, res) => {
  const { name, phone } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'الاسم مطلوب' });
  const data = loadData();
  data.team.push({ id: Date.now(), name: name.trim(), phone: phone?.trim() || '', count: 0 });
  saveData(data); res.json({ ok: true });
});

app.delete('/api/team/:id', (req, res) => {
  const data = loadData();
  const idx = data.team.findIndex(m => m.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'مش موجود' });
  data.team.splice(idx, 1);
  if (data.currentIndex >= data.team.length && data.team.length > 0) data.currentIndex = 0;
  saveData(data); res.json({ ok: true });
});

app.post('/api/reset-index', (req, res) => {
  const data = loadData(); data.currentIndex = 0; saveData(data); res.json({ ok: true });
});

app.post('/api/reset-assignments', (req, res) => {
  const data = loadData();
  data.assignments = {}; data.leads = []; data.currentIndex = 0;
  data.team.forEach(m => m.count = 0);
  saveData(data); res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
  const data = loadData();
  if (!data.settings) data.settings = {};
  if (req.body.expiryHours) data.settings.expiryHours = parseInt(req.body.expiryHours);
  saveData(data); res.json({ ok: true });
});
