/**
 * Monlix Postback & Telegram Mini App Backend Server (Node.js / Express)
 * Интеграция с базой данных Supabase (PostgreSQL)
 *
 * Стек: Node.js, Express, Cors, @supabase/supabase-js, dotenv
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

// Инициализация Express приложения
const app = express();
const PORT = process.env.PORT || 3000;

// Подключение middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// КОНФИГУРАЦИЯ И ПОДКЛЮЧЕНИЕ К SUPABASE
// ==========================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MONLIX_SECRET = process.env.MONLIX_SECRET || 'SECRET_KEY_12345';

// Экономические параметры
const USER_REWARD_PERCENTAGE = 0.60; // 60% пользователю (40% сервису)
const TON_RATE_USD = 5.20;           // 1 TON = 5.20 USD

// Создание клиента Supabase
const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ==========================================
// 1. POSTBACK ЭНДПОИНТ ОТ MONLIX
// ==========================================
app.get('/api/postback', async (req, res) => {
  try {
    const { user_id, amount, trans_id, secret } = req.query;

    // 1. Проверка обязательных параметров
    if (!user_id || amount === undefined || !trans_id) {
      return res.status(400).send('Missing required parameters (user_id, amount, trans_id are required)');
    }

    // 2. Проверка секрета Monlix
    if (secret && secret !== MONLIX_SECRET) {
      return res.status(403).send('Invalid secret');
    }

    const cleanTransId = String(trans_id).trim();
    const cleanUserId = String(user_id).trim();
    const parsedAmount = parseFloat(String(amount));

    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).send('Invalid amount value');
    }

    if (!supabase) {
      return res.status(500).send('Database connection error: SUPABASE_URL and SUPABASE_KEY must be configured in .env');
    }

    // 3. Защита от повторных начислений: проверка транзакции в таблице completed_offers
    const { data: existingOffer, error: checkError } = await supabase
      .from('completed_offers')
      .select('trans_id')
      .eq('trans_id', cleanTransId)
      .maybeSingle();

    if (checkError) {
      console.error('[SUPABASE ERROR] Ошибка проверки trans_id:', checkError.message);
      return res.status(500).send('Database query error');
    }

    // Если транзакция уже существует, возвращаем "OK" (дедупликация), не начисляя повторно
    if (existingOffer) {
      console.log(`[POSTBACK DUP] Транзакция ${cleanTransId} уже обработана. Баланс повторно не начисляется.`);
      return res.status(200).send('OK');
    }

    // 4. Экономика: удержание комиссии 40% (пользователю 60%) и перевод в TON (1 TON = 5.20 USD)
    const usdToUser = parsedAmount * USER_REWARD_PERCENTAGE;
    const rawTonToUser = usdToUser / TON_RATE_USD;
    const tonToUser = Math.round(rawTonToUser * 10000) / 10000;

    // 5. Получение текущего баланса пользователя из таблицы 'users'
    const { data: userData, error: userFetchError } = await supabase
      .from('users')
      .select('balance_ton')
      .eq('telegram_id', cleanUserId)
      .maybeSingle();

    if (userFetchError) {
      console.error('[SUPABASE ERROR] Ошибка чтения баланса:', userFetchError.message);
      return res.status(500).send('Database read error');
    }

    const currentBalance = userData?.balance_ton ? parseFloat(String(userData.balance_ton)) : 0.0000;
    const updatedBalance = Math.round((currentBalance + tonToUser) * 10000) / 10000;

    // 6. UPSERT в таблицу 'users': добавление пользователя или обновление существующего balance_ton
    const { error: upsertError } = await supabase
      .from('users')
      .upsert(
        {
          telegram_id: cleanUserId,
          balance_ton: updatedBalance,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'telegram_id' }
      );

    if (upsertError) {
      console.error('[SUPABASE ERROR] Ошибка UPSERT в users:', upsertError.message);
      return res.status(500).send('Database update error');
    }

    // 7. Сохранение транзакции в таблицу 'completed_offers' для защиты от повторных начислений
    const { error: insertOfferError } = await supabase
      .from('completed_offers')
      .insert([
        {
          trans_id: cleanTransId,
          telegram_id: cleanUserId,
          amount_usd: parsedAmount,
          ton_amount: tonToUser,
          created_at: new Date().toISOString()
        }
      ]);

    if (insertOfferError) {
      if (insertOfferError.code === '23505') {
        return res.status(200).send('OK');
      }
      console.error('[SUPABASE ERROR] Ошибка записи в completed_offers:', insertOfferError.message);
      return res.status(500).send('Database insert error');
    }

    console.log(`[POSTBACK SUCCESS] Telegram ID: ${cleanUserId} | Trans: ${cleanTransId} | TON: +${tonToUser} | Баланс: ${updatedBalance}`);
    return res.status(200).send('OK');

  } catch (err) {
    console.error('[POSTBACK EXCEPTION]', err);
    return res.status(500).send('Internal Server Error');
  }
});

// ==========================================
// 2. ЭНДПОИНТЫ ДЛЯ TELEGRAM MINI APP
// ==========================================

// GET /api/user-balance?userId=...
app.get('/api/user-balance', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'Параметр userId обязателен' });
    }

    const cleanUserId = String(userId).trim();

    if (!supabase) {
      return res.status(500).json({ error: 'База данных Supabase не настроена в .env' });
    }

    // Запрос баланса из таблицы 'users'
    const { data, error } = await supabase
      .from('users')
      .select('balance_ton')
      .eq('telegram_id', cleanUserId)
      .maybeSingle();

    if (error) {
      console.error('[SUPABASE ERROR] Ошибка получения баланса:', error.message);
      return res.status(500).json({ error: 'Ошибка при чтении данных из базы' });
    }

    const balance = data?.balance_ton !== undefined ? parseFloat(String(data.balance_ton)) : 0.0000;

    return res.json({
      telegram_id: cleanUserId,
      user_id: cleanUserId,
      balance_ton: balance
    });

  } catch (err) {
    console.error('[USER-BALANCE EXCEPTION]', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/tasks
app.get('/api/tasks', (_req, res) => {
  return res.json(mockTasks);
});

// Базовый статус
app.get('/', (_req, res) => {
  res.send('Monlix Postback & Telegram Mini App Supabase Backend is running!');
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is listening on port ${PORT}`);
});

export default app;
