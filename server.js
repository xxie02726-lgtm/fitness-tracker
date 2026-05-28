/**
 * GlowFit Backend Server
 * 提供 DeepSeek AI 代理 + Apple Watch 数据同步 API
 *
 * 启动方式:
 *   node server.js
 *   或者设置环境变量 PORT=3001 node server.js
 *
 * DeepSeek API 配置:
 *   在 .env 文件中设置 DEEPSEEK_API_KEY=sk-your-key-here
 *   或者设置环境变量 DEEPSEEK_API_KEY
 *   未设置时 API 将返回模拟数据（演示模式）
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// ---- 加载 .env 文件 ----
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    });
    console.log('📄 已加载 .env 配置文件');
  }
} catch (e) { /* ignore */ }

// ---- 配置 ----
const PORT = process.env.PORT || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const WATCH_DATA_FILE = path.join(__dirname, 'watch_data.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// ---- 持久化存储 ----
function loadWatchData() {
  try {
    if (fs.existsSync(WATCH_DATA_FILE)) {
      return JSON.parse(fs.readFileSync(WATCH_DATA_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveWatchData(data) {
  fs.writeFileSync(WATCH_DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ============================================================
//  1. DeepSeek AI 聊天代理
// ============================================================
/**
 * 系统提示词 —— 告诉 DeepSeek 它是什么角色、如何解析数据
 */
const SYSTEM_PROMPT = `你是一个专业的健身与营养 AI 教练，名叫「GlowFit」。你的核心能力是：

1. **自然语言解析**：当用户描述饮食或运动时，从中提取结构化数据。
2. **自动记录建议**：返回 JSON 格式的数据，让前端可以一键填入记录。
3. **专业建议**：根据用户剩余热量给出幽默、鼓励或专业的建议。

## 返回格式
你必须始终返回一个 JSON 对象（不要包含 markdown 代码块标记），格式如下：

{
  "action": "add_food" | "add_workout" | "add_both" | "advice_only",
  "message": "你对用户说的自然语言回复，亲切有活力，可中英文混合，带适量 emoji",
  "foods": [
    {
      "name": "食物名称",
      "meal": "早餐|午餐|晚餐|加餐",
      "weight": 100,
      "cal": 热量数值,
      "protein": 蛋白质克数,
      "carb": 碳水克数,
      "fat": 脂肪克数
    }
  ],
  "workouts": [
    {
      "name": "运动名称",
      "type": "力量|有氧|柔韧|球类|其他",
      "duration": 分钟数,
      "cal": 消耗热量,
      "sets": 组数,
      "reps": 次数
    }
  ]
}

## 识别规则
- 如果用户提到"吃了"、"喝了"、"早餐/午餐/晚餐/加餐" → 归类为 add_food 或 add_both
- 如果用户提到"跑了"、"练了"、"做了"、"运动"、"深蹲"等 → 归类为 add_workout 或 add_both
- 如果用户只是闲聊/问建议 → action 为 "advice_only"，不返回 foods/workouts
- 估算热量和营养素时基于常见食物数据库，合理即可，不必精确到个位数
- 餐次可根据时间合理推测（早上→早餐，中午→午餐，晚上→晚餐）

## 性格设定
- 亲切、幽默、有活力
- 偶尔调侃，但保持专业
- 可以用"老铁"、"伙计"等亲切称呼
- 适当使用 emoji 增加活力`;

/**
 * POST /api/chat
 * Body: { messages: [{ role: "user"|"assistant", content: "..." }] }
 * 如果传了 context，也一并带上当前热量数据
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, context } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '请提供 messages 数组' });
    }

    // 构建完整消息列表（系统提示 + 上下文 + 用户消息）
    const fullMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    // 如果有上下文数据（今日热量等），作为辅助信息传入
    if (context) {
      fullMessages.push({
        role: 'system',
        content: `【用户今日实时数据】\n${JSON.stringify(context, null, 2)}\n注意：热量单位为千卡(kcal)。如用户询问剩余热量或建议，请参考此数据。`
      });
    }

    // 追加对话历史
    messages.forEach(m => fullMessages.push(m));

    // ---- 调用 DeepSeek API ----
    if (DEEPSEEK_API_KEY) {
      // 真实模式：调用 DeepSeek API
      const response = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: fullMessages,
          temperature: 0.8,
          max_tokens: 1024,
          stream: false
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('DeepSeek API error:', response.status, errText);
        return res.status(502).json({ error: 'DeepSeek API 调用失败', detail: errText });
      }

      const data = await response.json();
      const reply = data.choices[0].message.content;

      // 尝试解析返回的 JSON
      try {
        // 去掉可能的 markdown 代码块包裹
        const cleaned = reply.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
        const parsed = JSON.parse(cleaned);
        return res.json({ success: true, data: parsed, raw: reply });
      } catch (parseErr) {
        // 如果返回非 JSON，当作普通文本返回
        return res.json({
          success: true,
          data: {
            action: 'advice_only',
            message: reply,
            foods: [],
            workouts: []
          },
          raw: reply
        });
      }
    } else {
      // ---- 演示模式：用规则引擎模拟 DeepSeek 回复 ----
      await new Promise(r => setTimeout(r, 800)); // 模拟延迟
      const lastMsg = messages[messages.length - 1]?.content || '';
      const simulated = simulateAIResponse(lastMsg, context);
      return res.json({ success: true, data: simulated, raw: simulated.message });
    }
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

/**
 * 演示模式下的规则模拟器
 * 当未配置 DeepSeek API Key 时使用
 */
function simulateAIResponse(userMsg, context) {
  const msg = userMsg.toLowerCase();

  // 检测是否有食物描述
  const foodKeywords = ['吃', '喝', '早餐', '午餐', '晚餐', '加餐', '米饭', '面', '鸡', '肉', '蛋', '奶', '果', '菜', '汤', '沙拉'];
  const hasFood = foodKeywords.some(k => msg.includes(k));

  // 检测是否有运动描述
  const workoutKeywords = ['跑', '走', '游', '跳', '深蹲', '卧推', '举', '练', '运动', '健身', '瑜伽', '骑', '爬', 'HIIT'];
  const hasWorkout = workoutKeywords.some(k => msg.includes(k));

  const result = { foods: [], workouts: [], message: '' };

  if (hasFood && hasWorkout) {
    result.action = 'add_both';
    // 智能提取食物信息
    result.foods = extractFoods(msg);
    result.workouts = extractWorkouts(msg);
    const foodCal = result.foods.reduce((s, f) => s + f.cal, 0);
    const woCal = result.workouts.reduce((s, w) => s + w.cal, 0);
    const remain = context ? (context.goalCal || 2000) - (context.calIn || 0) + (context.calOut || 0) - foodCal + woCal : 0;
    result.message = `收到！已帮你记录 ${result.foods.length} 项饮食和 ${result.workouts.length} 项运动 🎯\n\n` +
      `📊 饮食小计：${foodCal} kcal | 运动消耗：${woCal} kcal\n` +
      (remain > 0
        ? `今天还能再吃约 ${Math.round(remain)} kcal，要不要奖励自己一口小零食？😄`
        : `今天热量预算已达标，干得漂亮！休息一下别吃夜宵了 💪`);
  } else if (hasFood) {
    result.action = 'add_food';
    result.foods = extractFoods(msg);
    const foodCal = result.foods.reduce((s, f) => s + f.cal, 0);
    const remain = context ? (context.goalCal || 2000) - (context.calIn || 0) - foodCal : 0;
    const mealNames = result.foods.map(f => f.name).join('、');
    result.message = `好嘞！已识别出「${mealNames}」，帮你记录上了 👇\n\n` +
      `🔥 本次摄入约 ${foodCal} kcal\n` +
      (remain > 300
        ? `今天还剩 ${Math.round(remain)} kcal 的预算，晚餐还能吃顿好的！😋`
        : remain > 0
          ? `今天还剩 ${Math.round(remain)} kcal，注意控制哦～`
          : `今天热量已超标 ${Math.abs(Math.round(remain))} kcal，快去运动消耗一下吧！🏃`);
  } else if (hasWorkout) {
    result.action = 'add_workout';
    result.workouts = extractWorkouts(msg);
    const woCal = result.workouts.reduce((s, w) => s + w.cal, 0);
    result.message = `帅！已记录你的运动 💪\n\n` +
      `🏋️ 消耗约 ${woCal} kcal\n` +
      (woCal > 200
        ? `这运动量够猛，今晚可以放心加个鸡腿了！🍗`
        : `运动量不错！加点力量训练效果会更好哦～`);
  } else {
    result.action = 'advice_only';
    // 智能建议
    if (context) {
      const remain = (context.goalCal || 2000) - (context.calIn || 0) + (context.calOut || 0);
      if (remain > 500) {
        result.message = `目前来看你今天剩余热量还不少呢（约 ${Math.round(remain)} kcal）🔥\n\n` +
          `建议：\n1️⃣ 晚餐可以正常吃，注意蛋白质摄入 🥩\n2️⃣ 如果还没运动，现在动起来可以多吃 200 kcal！\n3️⃣ 多喝水，促进代谢 💧\n\n有什么具体问题随时问我～`;
      } else if (remain > 0) {
        result.message = `今天预算还剩约 ${Math.round(remain)} kcal，控制得不错！👏\n\n` +
          `小贴士：\n• 如果感觉饿，可以吃点黄瓜或番茄 🥒\n• 睡前 3 小时最好不要进食哦\n• 今天有运动计划吗？我可以帮你记录！`;
      } else {
        result.message = `今天热量已超标 ${Math.abs(Math.round(remain))} kcal，不过别担心！😅\n\n` +
          `补救方案：\n• 明天早餐少吃一点 🥗\n• 今晚做 30 分钟有氧就能消耗回来 🏃\n• 记录本身就是进步，明天继续加油！💪`;
      }
    } else {
      result.message = `嗨！我是你的 GlowFit AI 教练 🤖💚\n\n` +
        `你可以这样跟我聊天：\n` +
        `🥗 「今天中午吃了半碗米饭和番茄炒蛋」\n` +
        `🏃 「下午跑了 3 公里」\n` +
        `💬 「我今天还剩多少热量？」\n\n` +
        `我来帮你自动记录和分析，开始吧！`;
    }
  }

  return result;
}

function extractFoods(msg) {
  const foods = [];
  const rules = [
    { match: /米饭|饭/, name: '白米饭', cal: 130, protein: 2.7, carb: 28, fat: 0.3, defaultWeight: 150 },
    { match: /番茄炒蛋/, name: '番茄炒蛋', cal: 85, protein: 4.5, carb: 4, fat: 5, defaultWeight: 200 },
    { match: /鸡胸|鸡胸肉|鸡肉/, name: '鸡胸肉', cal: 165, protein: 31, carb: 0, fat: 3.6, defaultWeight: 150 },
    { match: /鸡蛋|蛋/, name: '鸡蛋', cal: 72, protein: 6.5, carb: 0.5, fat: 4.8, defaultWeight: 50 },
    { match: /牛奶|牛乳/, name: '牛奶', cal: 61, protein: 3.2, carb: 4.8, fat: 3.2, defaultWeight: 250 },
    { match: /香蕉/, name: '香蕉', cal: 89, protein: 1.1, carb: 23, fat: 0.3, defaultWeight: 120 },
    { match: /苹果/, name: '苹果', cal: 52, protein: 0.3, carb: 14, fat: 0.2, defaultWeight: 200 },
    { match: /牛肉/, name: '牛肉', cal: 250, protein: 26, carb: 0, fat: 15, defaultWeight: 150 },
    { match: /三文鱼|鱼/, name: '三文鱼', cal: 208, protein: 20, carb: 0, fat: 13, defaultWeight: 150 },
    { match: /牛油果/, name: '牛油果', cal: 160, protein: 2, carb: 8.5, fat: 14.7, defaultWeight: 100 },
    { match: /沙拉/, name: '蔬菜沙拉', cal: 45, protein: 2, carb: 5, fat: 1.5, defaultWeight: 200 },
    { match: /面包|吐司/, name: '全麦面包', cal: 247, protein: 9, carb: 41, fat: 3.4, defaultWeight: 60 },
    { match: /燕麦/, name: '燕麦', cal: 389, protein: 17, carb: 66, fat: 7, defaultWeight: 40 },
    { match: /红薯/, name: '红薯', cal: 86, protein: 1.6, carb: 20, fat: 0.1, defaultWeight: 200 },
    { match: /咖啡|美式/, name: '美式咖啡', cal: 5, protein: 0.3, carb: 0, fat: 0, defaultWeight: 300 },
    { match: /豆腐/, name: '豆腐', cal: 76, protein: 8, carb: 1.9, fat: 4.2, defaultWeight: 150 },
    { match: /面|面条/, name: '面条', cal: 138, protein: 4.5, carb: 28, fat: 0.5, defaultWeight: 200 },
  ];

  // 判断餐次
  let meal = '午餐';
  if (msg.includes('早')) meal = '早餐';
  else if (msg.includes('晚')) meal = '晚餐';
  else if (msg.includes('加') || msg.includes('零食')) meal = '加餐';

  for (const rule of rules) {
    if (rule.match.test(msg)) {
      const w = rule.defaultWeight;
      const pct = w / 100;
      foods.push({
        name: rule.name, meal,
        weight: w,
        cal: Math.round(rule.cal * pct),
        protein: Math.round(rule.protein * pct * 10) / 10,
        carb: Math.round(rule.carb * pct * 10) / 10,
        fat: Math.round(rule.fat * pct * 10) / 10
      });
    }
  }

  // 提取"半碗"、"一碗"等量词
  const bowlMatch = msg.match(/(半|一|两|三)?碗\s*米饭/);
  if (bowlMatch) {
    const qty = bowlMatch[1] || '一';
    const factor = qty === '半' ? 0.5 : qty === '两' ? 2 : qty === '三' ? 3 : 1;
    // 找到已添加的米饭并调整
    const rice = foods.find(f => f.name === '白米饭');
    if (rice) {
      rice.weight = Math.round(100 * factor);
      const pct = rice.weight / 100;
      rice.cal = Math.round(130 * pct);
      rice.protein = Math.round(2.7 * pct * 10) / 10;
      rice.carb = Math.round(28 * pct * 10) / 10;
      rice.fat = Math.round(0.3 * pct * 10) / 10;
    }
  }

  return foods;
}

function extractWorkouts(msg) {
  const workouts = [];
  const rules = [
    { match: /跑/, name: '跑步', type: '有氧', calPerMin: 10 },
    { match: /走|步行/, name: '步行', type: '有氧', calPerMin: 5 },
    { match: /游泳|游/, name: '游泳', type: '有氧', calPerMin: 12 },
    { match: /深蹲/, name: '深蹲', type: '力量', calPerMin: 8 },
    { match: /卧推/, name: '卧推', type: '力量', calPerMin: 6 },
    { match: /硬拉/, name: '硬拉', type: '力量', calPerMin: 7 },
    { match: /瑜伽/, name: '瑜伽', type: '柔韧', calPerMin: 4 },
    { match: /HIIT|间歇/, name: 'HIIT 燃脂', type: '有氧', calPerMin: 14 },
    { match: /骑行|骑|单车/, name: '骑行', type: '有氧', calPerMin: 8 },
    { match: /跳|跳绳/, name: '跳绳', type: '有氧', calPerMin: 13 },
    { match: /举铁|力量/, name: '力量训练', type: '力量', calPerMin: 7 },
  ];

  for (const rule of rules) {
    if (rule.match.test(msg)) {
      // 提取距离或时长
      let duration = 30;
      const distMatch = msg.match(/(\d+\.?\d*)\s*公里/);
      const minMatch = msg.match(/(\d+)\s*分钟/);
      if (minMatch) duration = parseInt(minMatch[1]);
      else if (distMatch) duration = Math.round(parseFloat(distMatch[1]) * 6); // 假设 10min/km

      workouts.push({
        name: rule.name, type: rule.type,
        duration: duration,
        cal: Math.round(duration * rule.calPerMin),
        sets: 0, reps: 0
      });
    }
  }
  return workouts;
}

// ============================================================
//  2. Apple Watch 数据同步 API
// ============================================================

/**
 * POST /api/sync-watch-data
 * 从 Apple Watch / iPhone 快捷指令接收健康数据
 *
 * 请求体 JSON:
 * {
 *   "activeCalories": 350,      // 运动消耗热量 (kcal)
 *   "steps": 8500,              // 步数
 *   "distance": 6.2,            // 距离 (公里)
 *   "heartRate": 72,            // 平均心率 (bpm) 可选
 *   "exerciseMinutes": 35,      // 锻炼分钟数 可选
 *   "standHours": 10,           // 站立小时数 可选
 *   "timestamp": "2026-05-28T12:00:00Z",  // ISO 8601 时间戳
 *   "date": "2026-05-28"        // 可选，不传则从 timestamp 提取
 * }
 *
 * 响应:
 * { "success": true, "message": "数据同步成功", "data": {...} }
 */
app.post('/api/sync-watch-data', (req, res) => {
  try {
    const {
      activeCalories = 0,
      steps = 0,
      distance = 0,
      heartRate,
      exerciseMinutes = 0,
      standHours = 0,
      timestamp = new Date().toISOString(),
      date
    } = req.body;

    // 参数校验
    if (activeCalories === 0 && steps === 0 && distance === 0) {
      return res.status(400).json({
        success: false,
        error: '至少需要提供 activeCalories、steps 或 distance 中的一个'
      });
    }

    const recordDate = date || timestamp.split('T')[0] || new Date().toISOString().split('T')[0];

    const record = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: recordDate,
      activeCalories: Math.round(activeCalories),
      steps: Math.round(steps),
      distance: Math.round(distance * 100) / 100,
      heartRate: heartRate ? Math.round(heartRate) : null,
      exerciseMinutes: Math.round(exerciseMinutes),
      standHours: Math.round(standHours * 10) / 10,
      timestamp,
      receivedAt: new Date().toISOString()
    };

    // 保存数据
    const allData = loadWatchData();
    // 同一天只保留最新一条
    const filtered = allData.filter(r => r.date !== recordDate);
    filtered.push(record);
    saveWatchData(filtered);

    res.json({
      success: true,
      message: `✅ ${recordDate} 数据同步成功！消耗 ${record.activeCalories} kcal，步数 ${record.steps} 步`,
      data: record
    });
  } catch (err) {
    console.error('Sync watch data error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/watch-data
 * 获取 Apple Watch 同步的历史数据
 * Query: ?date=2026-05-28  （可选，筛选指定日期）
 *        ?limit=7           （可选，返回最近 N 条，默认 30）
 */
app.get('/api/watch-data', (req, res) => {
  try {
    let data = loadWatchData();
    const { date, limit = 30 } = req.query;

    if (date) {
      data = data.filter(r => r.date === date);
    }

    // 按日期降序排列
    data.sort((a, b) => b.date.localeCompare(a.date));

    res.json({
      success: true,
      count: data.length,
      data: data.slice(0, parseInt(limit))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/watch-data/latest
 * 获取最新一条同步记录
 */
app.get('/api/watch-data/latest', (req, res) => {
  const data = loadWatchData();
  data.sort((a, b) => b.date.localeCompare(a.date));
  res.json({
    success: true,
    data: data[0] || null
  });
});

// ============================================================
//  3. 健康检查 & 根路由
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    deepseek: DEEPSEEK_API_KEY ? 'connected' : 'demo_mode',
    watchRecords: loadWatchData().length,
    time: new Date().toISOString()
  });
});

// ============================================================
//  4. 所有未匹配路由 → index.html（兼容 Render 部署）
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
//  启动服务器
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║         GlowFit 服务端已启动 🟢              ║
╠══════════════════════════════════════════════╣
║  服务端口: ${PORT}
║  DeepSeek: ${DEEPSEEK_API_KEY ? '已连接 ✅' : '演示模式 ⚠️（无 API Key）'}
║  Watch数据: ${loadWatchData().length} 条记录
║  静态文件: 当前目录
║                                              ║
║  前端地址: http://localhost:${PORT}
║  API 健康: http://localhost:${PORT}/api/health
╚══════════════════════════════════════════════╝
  `.replace('DEEPSEEP_API_KEY', 'DEEPSEEK_API_KEY'));
});
