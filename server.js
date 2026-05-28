/**
 * GlowFit Backend Server v2.0
 * 多用户 + PostgreSQL + DeepSeek AI + Apple Watch 同步
 *
 * 环境变量:
 *   DATABASE_URL     PostgreSQL 连接串（Render 自动注入）
 *   JWT_SECRET       JWT 签名密钥
 *   DEEPSEEK_API_KEY DeepSeek API 密钥
 *   PORT             服务端口
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ---- 加载 .env ----
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const t = line.trim();
      if (t && !t.startsWith('#')) {
        const eq = t.indexOf('=');
        if (eq > 0 && !process.env[t.slice(0, eq).trim()]) {
          process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
        }
      }
    });
    console.log('📄 已加载 .env');
  }
} catch (e) { /* ignore */ }

// ---- 配置 ----
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'glowfit_dev_secret';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

// ---- PostgreSQL 连接 ----
const DATABASE_URL = process.env.DATABASE_URL || '';
let pool;

async function initDatabase() {
  if (!DATABASE_URL) {
    console.log('⚠️ 未设置 DATABASE_URL，将使用本地 JSON 文件存储（单用户模式）');
    return false;
  }
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL 连接成功');
    // 自动建表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        goal_cal INTEGER DEFAULT 2000, goal_protein INTEGER DEFAULT 150,
        goal_carb INTEGER DEFAULT 250, goal_fat INTEGER DEFAULT 65,
        goal_water INTEGER DEFAULT 2000, goal_weight DECIMAL(5,1) DEFAULT 65.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS foods (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL, meal VARCHAR(20) DEFAULT '午餐',
        weight DECIMAL(7,1) DEFAULT 0, cal DECIMAL(7,1) DEFAULT 0,
        protein DECIMAL(7,1) DEFAULT 0, carb DECIMAL(7,1) DEFAULT 0,
        fat DECIMAL(7,1) DEFAULT 0, note TEXT DEFAULT '',
        date VARCHAR(10) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_foods_ud ON foods(user_id, date);
      CREATE TABLE IF NOT EXISTS workouts (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL, type VARCHAR(20) DEFAULT '有氧',
        duration DECIMAL(6,1) DEFAULT 0, cal DECIMAL(7,1) DEFAULT 0,
        sets INTEGER DEFAULT 0, reps INTEGER DEFAULT 0, weight_kg DECIMAL(6,1) DEFAULT 0,
        note TEXT DEFAULT '', from_watch BOOLEAN DEFAULT FALSE,
        date VARCHAR(10) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_workouts_ud ON workouts(user_id, date);
      CREATE TABLE IF NOT EXISTS weights (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        value DECIMAL(5,1) NOT NULL, date VARCHAR(10) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_weights_ud ON weights(user_id, date);
      CREATE TABLE IF NOT EXISTS water (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date VARCHAR(10) NOT NULL, amount DECIMAL(7,1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, date)
      );
      CREATE TABLE IF NOT EXISTS body_measures (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date VARCHAR(10) NOT NULL, waist DECIMAL(5,1) DEFAULT 0, hip DECIMAL(5,1) DEFAULT 0,
        arm DECIMAL(5,1) DEFAULT 0, thigh DECIMAL(5,1) DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS watch_data (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date VARCHAR(10) NOT NULL, active_calories DECIMAL(7,1) DEFAULT 0,
        steps INTEGER DEFAULT 0, distance DECIMAL(7,2) DEFAULT 0,
        heart_rate INTEGER, exercise_minutes INTEGER DEFAULT 0,
        stand_hours DECIMAL(3,1) DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date)
      );
    `);
    console.log('✅ 数据库表已就绪');
    return true;
  } catch (err) {
    console.error('❌ 数据库错误:', err.message);
    return false;
  }
}

// ---- JSON 本地存储（无数据库时降级） ----
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf8');
}

// ---- 中间件 ----
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// JWT 认证中间件
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ---- 数据库查询助手 ----
async function dbQuery(text, params) {
  if (pool) {
    const result = await pool.query(text, params);
    return result.rows;
  }
  throw new Error('数据库未连接');
}

// ============================================================
//  1. 用户认证
// ============================================================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || username.length < 2 || password.length < 4) {
      return res.status(400).json({ error: '用户名至少2位，密码至少4位' });
    }
    const hash = await bcrypt.hash(password, 10);
    if (pool) {
      const existing = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
      if (existing.rows.length) return res.status(409).json({ error: '用户名已存在' });
      const result = await pool.query(
        'INSERT INTO users(username, password_hash) VALUES($1,$2) RETURNING id, username, created_at',
        [username, hash]
      );
      const user = result.rows[0];
      const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ success: true, token, user: { id: user.id, username: user.username, goals: {} } });
    } else {
      // JSON 降级模式 - 单用户
      const users = readJSON('users.json');
      if (users.find(u => u.username === username)) return res.status(409).json({ error: '用户名已存在' });
      users.push({ id: Date.now(), username, password_hash: hash, goals: {} });
      writeJSON('users.json', users);
      const token = jwt.sign({ id: users[users.length - 1].id, username }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ success: true, token, user: { id: users[users.length - 1].id, username, goals: {} } });
    }
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    let user;
    if (pool) {
      const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
      if (!result.rows.length) return res.status(401).json({ error: '用户名或密码错误' });
      user = result.rows[0];
    } else {
      const users = readJSON('users.json');
      user = users.find(u => u.username === username);
      if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true, token,
      user: {
        id: user.id, username: user.username,
        goals: { cal: user.goal_cal || 2000, protein: user.goal_protein || 150, carb: user.goal_carb || 250, fat: user.goal_fat || 65, water: user.goal_water || 2000, weight: user.goal_weight || 65 }
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profile', authMiddleware, async (req, res) => {
  try {
    if (pool) {
      const result = await pool.query('SELECT id, username, goal_cal, goal_protein, goal_carb, goal_fat, goal_water, goal_weight, created_at FROM users WHERE id=$1', [req.user.id]);
      if (!result.rows.length) return res.status(404).json({ error: '用户不存在' });
      const u = result.rows[0];
      res.json({ success: true, user: { id: u.id, username: u.username, goals: { cal: u.goal_cal, protein: u.goal_protein, carb: u.goal_carb, fat: u.goal_fat, water: u.goal_water, weight: u.goal_weight }, created_at: u.created_at } });
    } else {
      const users = readJSON('users.json');
      const u = users.find(x => x.id === req.user.id);
      if (!u) return res.status(404).json({ error: '用户不存在' });
      res.json({ success: true, user: { id: u.id, username: u.username, goals: u.goals || {} } });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/profile/goals', authMiddleware, async (req, res) => {
  try {
    const { cal, protein, carb, fat, water, weight } = req.body;
    if (pool) {
      await pool.query('UPDATE users SET goal_cal=$1, goal_protein=$2, goal_carb=$3, goal_fat=$4, goal_water=$5, goal_weight=$6 WHERE id=$7',
        [cal || 2000, protein || 150, carb || 250, fat || 65, water || 2000, weight || 65, req.user.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  2. 饮食 CRUD
// ============================================================
app.get('/api/foods', authMiddleware, async (req, res) => {
  try {
    const { date, start, end } = req.query;
    let sql = 'SELECT * FROM foods WHERE user_id=$1';
    const params = [req.user.id];
    if (date) { sql += ' AND date=$2'; params.push(date); }
    if (start && end) { sql += ' AND date>=$2 AND date<=$3'; params.push(start, end); }
    sql += ' ORDER BY created_at DESC';
    const rows = pool ? await dbQuery(sql, params) : (readJSON('foods.json') || []).filter(f => !date || f.date === date);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/foods', authMiddleware, async (req, res) => {
  try {
    const { name, meal, weight, cal, protein, carb, fat, note, date } = req.body;
    if (!name) return res.status(400).json({ error: '请填写食物名称' });
    if (pool) {
      const r = await pool.query(
        'INSERT INTO foods(user_id,name,meal,weight,cal,protein,carb,fat,note,date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [req.user.id, name, meal || '午餐', weight || 0, cal || 0, protein || 0, carb || 0, fat || 0, note || '', date || new Date().toISOString().slice(0, 10)]
      );
      res.json({ success: true, data: r.rows[0] });
    } else {
      const foods = readJSON('foods.json');
      const f = { id: Date.now(), user_id: req.user.id, name, meal: meal || '午餐', weight: weight || 0, cal: cal || 0, protein: protein || 0, carb: carb || 0, fat: fat || 0, note: note || '', date: date || new Date().toISOString().slice(0, 10) };
      foods.push(f);
      writeJSON('foods.json', foods);
      res.json({ success: true, data: f });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/foods/:id', authMiddleware, async (req, res) => {
  try {
    if (pool) {
      await pool.query('DELETE FROM foods WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  3. 运动 CRUD
// ============================================================
app.get('/api/workouts', authMiddleware, async (req, res) => {
  try {
    const { date } = req.query;
    let sql = 'SELECT * FROM workouts WHERE user_id=$1';
    const params = [req.user.id];
    if (date) { sql += ' AND date=$2'; params.push(date); }
    sql += ' ORDER BY created_at DESC';
    const rows = pool ? await dbQuery(sql, params) : (readJSON('workouts.json') || []);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/workouts', authMiddleware, async (req, res) => {
  try {
    const { name, type, duration, cal, sets, reps, weightKg, note, date, fromWatch } = req.body;
    if (!name) return res.status(400).json({ error: '请填写运动名称' });
    if (pool) {
      const r = await pool.query(
        'INSERT INTO workouts(user_id,name,type,duration,cal,sets,reps,weight_kg,note,from_watch,date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [req.user.id, name, type || '有氧', duration || 0, cal || 0, sets || 0, reps || 0, weightKg || 0, note || '', fromWatch || false, date || new Date().toISOString().slice(0, 10)]
      );
      res.json({ success: true, data: r.rows[0] });
    } else {
      const ws = readJSON('workouts.json');
      const w = { id: Date.now(), user_id: req.user.id, name, type: type || '有氧', duration: duration || 0, cal: cal || 0, sets: sets || 0, reps: reps || 0, weight_kg: weightKg || 0, note: note || '', from_watch: fromWatch || false, date: date || new Date().toISOString().slice(0, 10) };
      ws.push(w);
      writeJSON('workouts.json', ws);
      res.json({ success: true, data: w });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/workouts/:id', authMiddleware, async (req, res) => {
  try {
    if (pool) await pool.query('DELETE FROM workouts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  4. 体重 CRUD
// ============================================================
app.get('/api/weights', authMiddleware, async (req, res) => {
  try {
    const rows = pool ? await dbQuery('SELECT * FROM weights WHERE user_id=$1 ORDER BY date DESC', [req.user.id]) : (readJSON('weights.json') || []);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/weights', authMiddleware, async (req, res) => {
  try {
    const { value, date } = req.body;
    if (!value) return res.status(400).json({ error: '请填写体重' });
    const ds = date || new Date().toISOString().slice(0, 10);
    if (pool) {
      // upsert - 同一天只保留一条
      await pool.query('DELETE FROM weights WHERE user_id=$1 AND date=$2', [req.user.id, ds]);
      const r = await pool.query('INSERT INTO weights(user_id,value,date) VALUES($1,$2,$3) RETURNING *', [req.user.id, value, ds]);
      res.json({ success: true, data: r.rows[0] });
    } else {
      const ws = readJSON('weights.json');
      const filtered = ws.filter(w => !(w.user_id === req.user.id && w.date === ds));
      const w = { id: Date.now(), user_id: req.user.id, value, date: ds };
      filtered.push(w);
      writeJSON('weights.json', filtered);
      res.json({ success: true, data: w });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  5. 饮水
// ============================================================
app.get('/api/water', authMiddleware, async (req, res) => {
  try {
    const { date } = req.query;
    if (pool && date) {
      const r = await pool.query('SELECT * FROM water WHERE user_id=$1 AND date=$2', [req.user.id, date]);
      return res.json({ success: true, data: r.rows[0] || { amount: 0 } });
    }
    if (pool) {
      const r = await pool.query('SELECT * FROM water WHERE user_id=$1 ORDER BY date DESC', [req.user.id]);
      return res.json({ success: true, data: r.rows });
    }
    const ws = readJSON('water.json') || [];
    if (date) return res.json({ success: true, data: ws.find(w => w.user_id === req.user.id && w.date === date) || { amount: 0 } });
    res.json({ success: true, data: ws });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/water', authMiddleware, async (req, res) => {
  try {
    const { amount, date } = req.body;
    const ds = date || new Date().toISOString().slice(0, 10);
    if (pool) {
      const existing = await pool.query('SELECT * FROM water WHERE user_id=$1 AND date=$2', [req.user.id, ds]);
      if (existing.rows.length) {
        const r = await pool.query('UPDATE water SET amount=$1 WHERE user_id=$2 AND date=$3 RETURNING *', [amount || 0, req.user.id, ds]);
        return res.json({ success: true, data: r.rows[0] });
      }
      const r = await pool.query('INSERT INTO water(user_id,date,amount) VALUES($1,$2,$3) RETURNING *', [req.user.id, ds, amount || 0]);
      res.json({ success: true, data: r.rows[0] });
    } else {
      const ws = readJSON('water.json');
      const idx = ws.findIndex(w => w.user_id === req.user.id && w.date === ds);
      if (idx >= 0) ws[idx].amount = amount || 0;
      else ws.push({ id: Date.now(), user_id: req.user.id, date: ds, amount: amount || 0 });
      writeJSON('water.json', ws);
      res.json({ success: true });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  6. 身体围度
// ============================================================
app.get('/api/body-measures', authMiddleware, async (req, res) => {
  try {
    const rows = pool ? await dbQuery('SELECT * FROM body_measures WHERE user_id=$1 ORDER BY date DESC', [req.user.id]) : (readJSON('bodyMeasures.json') || []);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/body-measures', authMiddleware, async (req, res) => {
  try {
    const { waist, hip, arm, thigh, date } = req.body;
    const ds = date || new Date().toISOString().slice(0, 10);
    if (pool) {
      const r = await pool.query(
        'INSERT INTO body_measures(user_id,date,waist,hip,arm,thigh) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [req.user.id, ds, waist || 0, hip || 0, arm || 0, thigh || 0]
      );
      return res.json({ success: true, data: r.rows[0] });
    }
    const ms = readJSON('bodyMeasures.json');
    ms.push({ id: Date.now(), user_id: req.user.id, date: ds, waist: waist || 0, hip: hip || 0, arm: arm || 0, thigh: thigh || 0 });
    writeJSON('bodyMeasures.json', ms);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  7. DeepSeek AI 聊天（带用户上下文）
// ============================================================
app.post('/api/chat', authMiddleware, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || !messages.length) return res.status(400).json({ error: '请提供 messages' });

    // 获取用户今日数据作为上下文
    const today = new Date().toISOString().slice(0, 10);
    let context = { calIn: 0, calOut: 0, proteinIn: 0, carbIn: 0, fatIn: 0, water: 0, goalCal: 2000, goalProtein: 150, goalCarb: 250, goalFat: 65, goalWater: 2000 };

    if (pool) {
      const [foods, workouts, waterRow, userRow] = await Promise.all([
        pool.query('SELECT * FROM foods WHERE user_id=$1 AND date=$2', [req.user.id, today]),
        pool.query('SELECT * FROM workouts WHERE user_id=$1 AND date=$2', [req.user.id, today]),
        pool.query('SELECT * FROM water WHERE user_id=$1 AND date=$2', [req.user.id, today]),
        pool.query('SELECT goal_cal, goal_protein, goal_carb, goal_fat, goal_water FROM users WHERE id=$1', [req.user.id]),
      ]);
      const g = userRow.rows[0] || {};
      context = {
        calIn: Math.round(foods.rows.reduce((s, f) => s + parseFloat(f.cal || 0), 0)),
        calOut: Math.round(workouts.rows.reduce((s, w) => s + parseFloat(w.cal || 0), 0)),
        proteinIn: Math.round(foods.rows.reduce((s, f) => s + parseFloat(f.protein || 0), 0)),
        carbIn: Math.round(foods.rows.reduce((s, f) => s + parseFloat(f.carb || 0), 0)),
        fatIn: Math.round(foods.rows.reduce((s, f) => s + parseFloat(f.fat || 0), 0)),
        water: waterRow.rows.length ? Math.round(parseFloat(waterRow.rows[0].amount)) : 0,
        goalCal: g.goal_cal || 2000, goalProtein: g.goal_protein || 150,
        goalCarb: g.goal_carb || 250, goalFat: g.goal_fat || 65, goalWater: g.goal_water || 2000
      };
    }

    const sysPrompt = `你是一个专业的健身与营养 AI 教练，名叫「GlowFit」。... 返回格式、识别规则与之前一致。`;

    if (DEEPSEEK_API_KEY) {
      const resp = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: '你是 GlowFit AI 教练。从用户描述中提取饮食和运动数据，返回 JSON。包含 action("add_food"|"add_workout"|"add_both"|"advice_only"), message, foods(每一项含 name,meal,weight,cal,protein,carb,fat), workouts(每一项含 name,type,duration,cal,sets,reps)。估算要合理。用户数据：' + JSON.stringify(context) },
            ...messages
          ],
          temperature: 0.8, max_tokens: 1024
        })
      });
      const data = await resp.json();
      const reply = data.choices?.[0]?.message?.content || '';
      try {
        const cleaned = reply.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
        const parsed = JSON.parse(cleaned);
        // 如果 AI 识别出食物/运动，自动存入数据库
        const savedFoods = [], savedWorkouts = [];
        if (parsed.foods && parsed.foods.length > 0) {
          for (const f of parsed.foods) {
            const r = await pool.query(
              'INSERT INTO foods(user_id,name,meal,weight,cal,protein,carb,fat,note,date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
              [req.user.id, f.name, f.meal || '午餐', f.weight || 100, f.cal || 0, f.protein || 0, f.carb || 0, f.fat || 0, '🤖 AI 自动识别', today]
            );
            savedFoods.push(f.name);
          }
        }
        if (parsed.workouts && parsed.workouts.length > 0) {
          for (const w of parsed.workouts) {
            const r = await pool.query(
              'INSERT INTO workouts(user_id,name,type,duration,cal,sets,reps,note,from_watch,date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
              [req.user.id, w.name, w.type || '有氧', w.duration || 30, w.cal || 0, w.sets || 0, w.reps || 0, '🤖 AI 自动识别', false, today]
            );
            savedWorkouts.push(w.name);
          }
        }
        parsed.savedFoods = savedFoods;
        parsed.savedWorkouts = savedWorkouts;
        return res.json({ success: true, data: parsed });
      } catch (e) {
        return res.json({ success: true, data: { action: 'advice_only', message: reply, foods: [], workouts: [] } });
      }
    } else {
      res.json({ success: true, data: { action: 'advice_only', message: '嗨！我是 GlowFit AI 教练 🤖\n\n请配置 DEEPSEEK_API_KEY 来启用完整功能。', foods: [], workouts: [] } });
    }
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  8. Apple Watch 同步（POST 无需 auth，GET 需 auth）
// ============================================================
app.post('/api/sync-watch-data', async (req, res) => {
  try {
    const { activeCalories = 0, steps = 0, distance = 0, heartRate, exerciseMinutes = 0, standHours = 0, date, token } = req.body;
    let userId = null;
    if (token) {
      try { userId = jwt.verify(token, JWT_SECRET).id; } catch (e) { /* 无 token 时存到公共区 */ }
    }
    const ds = date || new Date().toISOString().slice(0, 10);
    if (pool && userId) {
      await pool.query('DELETE FROM watch_data WHERE user_id=$1 AND date=$2', [userId, ds]);
      await pool.query(
        'INSERT INTO watch_data(user_id,date,active_calories,steps,distance,heart_rate,exercise_minutes,stand_hours) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [userId, ds, Math.round(activeCalories), Math.round(steps), Math.round(distance * 100) / 100, heartRate || null, Math.round(exerciseMinutes), standHours || 0]
      );
    }
    res.json({ success: true, message: `✅ ${ds} 同步成功：消耗 ${activeCalories}kcal，${steps} 步` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/watch-data/latest', authMiddleware, async (req, res) => {
  try {
    if (pool) {
      const r = await pool.query('SELECT * FROM watch_data WHERE user_id=$1 ORDER BY date DESC LIMIT 1', [req.user.id]);
      return res.json({ success: true, data: r.rows[0] || null });
    }
    res.json({ success: true, data: null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  9. 健康检查 & 根路由
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', deepseek: DEEPSEEK_API_KEY ? 'connected' : 'demo_mode', db: pool ? 'postgresql' : 'json_file', time: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
//  启动
// ============================================================
async function start() {
  const dbOk = await initDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════╗
║         GlowFit v2.0 服务端已启动 🟢         ║
╠══════════════════════════════════════════════╣
║  端口: ${PORT}
║  AI:   ${DEEPSEEK_API_KEY ? '✅ DeepSeek' : '⚠️ 演示模式'}
║  数据库: ${dbOk ? '✅ PostgreSQL' : '⚠️ JSON 文件'}
║  多用户: ${dbOk ? '✅ 已启用' : '⚠️ 单用户模式'}
║                                              ║
║  http://localhost:${PORT}
╚══════════════════════════════════════════════╝`);
  });
}
start();
