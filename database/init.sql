-- GlowFit 数据库初始化脚本
-- 使用方式: psql -h <host> -U <user> -d <dbname> -f database/init.sql

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  goal_cal INTEGER DEFAULT 2000,
  goal_protein INTEGER DEFAULT 150,
  goal_carb INTEGER DEFAULT 250,
  goal_fat INTEGER DEFAULT 65,
  goal_water INTEGER DEFAULT 2000,
  goal_weight DECIMAL(5,1) DEFAULT 65.0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 饮食记录
CREATE TABLE IF NOT EXISTS foods (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  meal VARCHAR(20) DEFAULT '午餐',
  weight DECIMAL(7,1) DEFAULT 0,
  cal DECIMAL(7,1) DEFAULT 0,
  protein DECIMAL(7,1) DEFAULT 0,
  carb DECIMAL(7,1) DEFAULT 0,
  fat DECIMAL(7,1) DEFAULT 0,
  note TEXT DEFAULT '',
  date VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_foods_user_date ON foods(user_id, date);

-- 运动记录
CREATE TABLE IF NOT EXISTS workouts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) DEFAULT '有氧',
  duration DECIMAL(6,1) DEFAULT 0,
  cal DECIMAL(7,1) DEFAULT 0,
  sets INTEGER DEFAULT 0,
  reps INTEGER DEFAULT 0,
  weight_kg DECIMAL(6,1) DEFAULT 0,
  note TEXT DEFAULT '',
  from_watch BOOLEAN DEFAULT FALSE,
  date VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date);

-- 体重记录
CREATE TABLE IF NOT EXISTS weights (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  value DECIMAL(5,1) NOT NULL,
  date VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_weights_user_date ON weights(user_id, date);

-- 饮水记录（每日总量）
CREATE TABLE IF NOT EXISTS water (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date VARCHAR(10) NOT NULL,
  amount DECIMAL(7,1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, date)
);

-- 身体围度
CREATE TABLE IF NOT EXISTS body_measures (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date VARCHAR(10) NOT NULL,
  waist DECIMAL(5,1) DEFAULT 0,
  hip DECIMAL(5,1) DEFAULT 0,
  arm DECIMAL(5,1) DEFAULT 0,
  thigh DECIMAL(5,1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Apple Watch 同步数据
CREATE TABLE IF NOT EXISTS watch_data (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date VARCHAR(10) NOT NULL,
  active_calories DECIMAL(7,1) DEFAULT 0,
  steps INTEGER DEFAULT 0,
  distance DECIMAL(7,2) DEFAULT 0,
  heart_rate INTEGER,
  exercise_minutes INTEGER DEFAULT 0,
  stand_hours DECIMAL(3,1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, date)
);
