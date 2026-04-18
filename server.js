const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ======= إعدادات =======
const DATA_FILE = path.join(__dirname, 'data', 'data.json');
const PORT = process.env.PORT || 3000;
const ASSIGNMENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ======= إدارة البيانات =======
function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadData() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    return { team: [], currentIndex: 0, assignments: {}, leads: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('خطأ في قراءة البيانات:', e);
    return { team: [], currentIndex: 0, assignments: {}, leads: [] };
  }
}

function saveData(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ======= واتساب =======
let isReady = false;
let currentQRBase64 = null;

// تحديد مسار Chrome حسب البيئة (Railway أو Windows)
function getChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  // Windows
  const windowsPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of windowsPaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // هيستخدم الافتراضي
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, 'data', '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    executablePath: getChromePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

client.on('qr', async (qr) => {
  console.log('\n📱 امسح الـ QR Code:');
  qrcodeTerminal.generate(qr, { small: true });
  try {
    currentQRBase64 = await qrcode.toDataURL(qr);
  } catch (e) {
    currentQRBase64 = null;
  }
});

client.on('ready', () => {
  console.log('\n✅ واتساب متصل بنجاح!');
  isReady = true;
  currentQRBase64 = null;
});

client.on('disconnected', (reason) => {
  console.log('❌ واتساب انفصل:', reason);
  isReady = false;
});

client.on('auth_failure', () => {
  console.log('❌ فشل التوثيق');
  isReady = false;
});

// ======= استقبال الرسائل =======
client.on('message', async (msg) => {
  if (msg.isGroupMsg || msg.fromMe) return;

  const from = msg.from;
  const phone = from.replace('@c.us', '').replace(/[^0-9]/g, '');
  const body = msg.body || '';
  const timestamp = Date.now();

  console.log(`\n📩 رسالة من: +${phone}`);

  let data = loadData();

  const existingAssignment = data.assignments[phone];
  const isExpired = existingAssignment &&
    (timestamp - existingAssignment.ts) > ASSIGNMENT_EXPIRY_MS;

  if (existingAssignment && !isExpired) {
    // عميل رجع - نفس السيلز
    const salesperson = data.team.find(m => m.id === existingAssignment.salesId);
    console.log(`   🔄 رجع → ${existingAssignment.salesName}`);

    if (salesperson && salesperson.phone) {
      const message = `🔄 *تواصل مرة تانية*\n\n` +
        `👤 العميل: *+${phone}*\n` +
        `💬 الرسالة: "${body}"\n\n` +
        `_ده عميلك من قبل - تابع معاه_ ✅`;
      try {
        await client.sendMessage(formatPhone(salesperson.phone), message);
      } catch (e) {
        console.error('فشل الإرسال:', e.message);
      }
    }

    data.leads.push({ id: timestamp, phone, message: body, type: 'return', assignedId: existingAssignment.salesId, assignedName: existingAssignment.salesName, ts: timestamp });
    data.assignments[phone].lastMessage = timestamp;
    saveData(data);
    return;
  }

  // ليد جديد
  if (!data.team.length) {
    console.log('   ⚠️ مفيش أعضاء في الفريق');
    return;
  }

  const idx = data.currentIndex % data.team.length;
  const member = data.team[idx];
  console.log(`   🎯 جديد → ${member.name}`);

  data.assignments[phone] = { salesId: member.id, salesName: member.name, ts: timestamp, lastMessage: timestamp };
  const memberInData = data.team.find(m => m.id === member.id);
  if (memberInData) memberInData.count = (memberInData.count || 0) + 1;
  data.currentIndex++;

  if (member.phone) {
    const message = `🎯 *ليد جديد!*\n\n` +
      `👤 رقم العميل: *+${phone}*\n` +
      `💬 الرسالة: "${body}"\n\n` +
      `_تواصل معاه دلوقتي_ 🚀`;
    try {
      await client.sendMessage(formatPhone(member.phone), message);
    } catch (e) {
      console.error('فشل الإرسال:', e.message);
    }
  }

  data.leads.push({ id: timestamp, phone, message: body, type: 'new', assignedId: member.id, assignedName: member.name, ts: timestamp });
  saveData(data);
});

function formatPhone(phone) {
  return phone.replace(/[^0-9]/g, '') + '@c.us';
}

// ======= API =======
app.get('/api/status', (req, res) => res.json({ ready: isReady, qr: currentQRBase64 }));
app.get('/api/data', (req, res) => res.json(loadData()));

app.post('/api/team', (req, res) => {
  const { name, phone } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'الاسم مطلوب' });
  const data = loadData();
  data.team.push({ id: Date.now(), name: name.trim(), phone: phone?.trim() || '', count: 0 });
  saveData(data);
  res.json({ ok: true });
});

app.delete('/api/team/:id', (req, res) => {
  const data = loadData();
  const idx = data.team.findIndex(m => m.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'مش موجود' });
  data.team.splice(idx, 1);
  if (data.currentIndex >= data.team.length && data.team.length > 0) data.currentIndex = 0;
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/reset-index', (req, res) => {
  const data = loadData();
  data.currentIndex = 0;
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/reset-assignments', (req, res) => {
  const data = loadData();
  data.assignments = {};
  data.leads = [];
  data.currentIndex = 0;
  data.team.forEach(m => m.count = 0);
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
  const data = loadData();
  if (!data.settings) data.settings = {};
  if (req.body.expiryHours) data.settings.expiryHours = parseInt(req.body.expiryHours);
  saveData(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n🚀 السيرفر شغال على PORT ${PORT}`);
  console.log('⏳ جاري الاتصال بواتساب...\n');
});

client.initialize();
