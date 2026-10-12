/**
 * Monlix Postback & Telegram Mini App Backend Server
 * 
 * Стек: Node.js, Express, Cors
 * Назначение:
 * 1. Обработка Postback запросов от CPA-оффервола Monlix (GET /api/postback)
 * 2. Безопасность: валидация секретного ключа и защита от повторных начислений (дедупликация trans_id)
 * 3. Экономика: удержание комиссии платформы 40% (пользователю 60%), конвертация в TON (1 TON = 5.20 USD)
 * 4. Локальное хранение балансов пользователей в TON
 * 5. Эндпоинты для Telegram Mini App: получение баланса пользователя и списка доступных заданий
 */

import express from 'express';
import cors from 'cors';

// Инициализация Express приложения
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// КОНФИГУРАЦИЯ И ЭКОНОМИКА
// ==========================================

// Секретный ключ для верификации запросов от оффервола Monlix
const MONLIX_SECRET = process.env.MONLIX_SECRET || 'SECRET_KEY_12345';

// Доля выплаты пользователю (60% от суммы задания, 40% удерживает сервис)
const USER_REWARD_PERCENTAGE = 0.60;

// Фиксированный обменный курс TON к USD (1 TON = 5.20 USD)
const TON_RATE_USD = 5.20;

// ==========================================
// ЛОКАЛЬНАЯ БАЗА ДАННЫХ (IN-MEMORY ДЛЯ MVP)
// ==========================================

// Балансы пользователей в TON: { [userId: string]: number }
const userBalances = {
  '123456789': 0.5000,
  '987654321': 1.2500
};

// Список обработанных уникальных идентификаторов транзакций (дедупликация)
const completedTransactions = [
  'tx_init_sample_001'
];

// Детальный реестр транзакций для истории и аудита
const transactionHistory = [
  {
    trans_id: 'tx_init_sample_001',
    user_id: '123456789',
    amount_usd: 4.3333,
    usd_to_user: 2.6000,
    ton_to_user: 0.5000,
    timestamp: new Date().toISOString()
  }
];

// Список офферов (задач) по умолчанию для Telegram Mini App
const mockTasks = [
  {
    id: 'task_001',
    title: 'Установка приложения OKX Crypto Exchange',
    description: 'Установите приложение и пройдите быструю верификацию уровня 1',
    category: 'Finance / Apps',
    amount_usd: 3.50,
    user_payout_usd: 2.10,
    user_payout_ton: 0.4038,
    action_url: 'https://monlix.com/offer/okx-app-install',
    icon_type: 'app',
    badge: 'Популярное'
  },
  {
    id: 'task_002',
    title: 'Опрос: Финансовые привычки и криптовалюта',
    description: 'Пройдите короткий 5-минутный социологический опрос от Kantar',
    category: 'Surveys',
    amount_usd: 1.20,
    user_payout_usd: 0.72,
    user_payout_ton: 0.1385,
    action_url: 'https://monlix.com/offer/kantar-survey-2026',
    icon_type: 'survey',
    badge: 'Быстро'
  },
  {
    id: 'task_003',
    title: 'Достичь 15 уровня в игре Lords Mobile',
    description: 'Скачайте игру на Android или iOS и прокачайте замок до 15 уровня за 7 дней',
    category: 'Gaming',
    amount_usd: 12.00,
    user_payout_usd: 7.20,
    user_payout_ton: 1.3846,
    action_url: 'https://monlix.com/offer/lords-mobile-level15',
    icon_type: 'game',
    badge: 'Высокая выплата'
  },
  {
    id: 'task_004',
    title: 'Регистрация и подписка на Telegram канал партнера',
    description: 'Подпишитесь на новостной канал аналитики и оставайтесь подписанным 3 дня',
    category: 'Social',
    amount_usd: 0.50,
    user_payout_usd: 0.30,
    user_payout_ton: 0.0577,
    action_url: 'https://monlix.com/offer/tg-channel-sub',
    icon_type: 'social',
    badge: 'Легко'
  },
  {
    id: 'task_005',
    title: 'Тест-драйв VPN сервиса Proton',
    description: 'Зарегистрируйте бесплатный аккаунт и активируйте 7-дневный пробный период',
    category: 'Security',
    amount_usd: 2.00,
    user_payout_usd: 1.20,
    user_payout_ton: 0.2308,
    action_url: 'https://monlix.com/offer/proton-vpn-trial',
    icon_type: 'service',
    badge: 'Топ'
  }
];

// ==========================================
// 1. POSTBACK ЭНДПОИНТ ОТ MONLIX
// ==========================================
app.get('/api/postback', (req, res) => {
  const { user_id, amount, trans_id, secret } = req.query;

  // 1. Проверка обязательных параметров
  if (!user_id || amount === undefined || !trans_id || !secret) {
    return res.status(400).send('Missing required parameters (user_id, amount, trans_id, secret are required)');
  }

  // 2. Защита и проверка безопасности: валидация секретного ключа
  if (secret !== MONLIX_SECRET) {
    console.warn(`[POSTBACK ERROR] Неверный секрет: ${secret}`);
    return res.status(403).send('Invalid secret');
  }

  const cleanTransId = String(trans_id).trim();
  const cleanUserId = String(user_id).trim();
  const parsedAmount = parseFloat(String(amount));

  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).send('Invalid amount value');
  }

  // 3. Защита от повторных начислений (дедупликация trans_id)
  if (completedTransactions.includes(cleanTransId)) {
    console.log(`[POSTBACK DUP] Транзакция ${cleanTransId} уже обработана. Ответ OK без начисления.`);
    return res.status(200).send('OK');
  }

  // 4. Экономика и конвертация в TON (удержание комиссии 40%, пользователю 60%)
  const usdToUser = parsedAmount * USER_REWARD_PERCENTAGE;
  const rawTonToUser = usdToUser / TON_RATE_USD;
  const tonToUser = Math.round(rawTonToUser * 10000) / 10000;

  // 5. Сохранение транзакции и обновление баланса пользователя
  completedTransactions.push(cleanTransId);

  const currentBalance = userBalances[cleanUserId] || 0;
  const updatedBalance = Math.round((currentBalance + tonToUser) * 10000) / 10000;
  userBalances[cleanUserId] = updatedBalance;

  // Запись в реестр транзакций
  transactionHistory.unshift({
    trans_id: cleanTransId,
    user_id: cleanUserId,
    amount_usd: parsedAmount,
    usd_to_user: Math.round(usdToUser * 10000) / 10000,
    ton_to_user: tonToUser,
    timestamp: new Date().toISOString()
  });

  console.log(`[POSTBACK SUCCESS] ID: ${cleanUserId} | Tx: ${cleanTransId} | TON: +${tonToUser} | Баланс: ${updatedBalance}`);
  return res.status(200).send('OK');
});

// ==========================================
// 2. ЭНДПОИНТЫ ДЛЯ TELEGRAM MINI APP
// ==========================================

// GET /api/user-balance?userId=...
app.get('/api/user-balance', (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'Параметр userId обязателен' });
  }

  const cleanUserId = String(userId).trim();
  const balance = userBalances[cleanUserId] !== undefined ? userBalances[cleanUserId] : 0.0000;

  return res.json({
    user_id: cleanUserId,
    balance_ton: balance
  });
});

// GET /api/tasks
app.get('/api/tasks', (req, res) => {
  return res.json(mockTasks);
});

// Проверка работоспособности
app.get('/', (req, res) => {
  res.send('Monlix Postback & Telegram Mini App Backend is running!');
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is listening on port ${PORT}`);
});

export default app;
