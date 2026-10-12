import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

// Обрабатываем запрос к тестовой странице ДО обычной раздачи статики
app.get('/test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// Раздача остальных файлов из папки public
app.use(express.static('public'));

// Прямое подключение к Postgres Supabase через Connection String
const { Pool } = pg;

console.log("=== ДИАГНОСТИКА БАЗЫ ДАННЫХ ===");
if (process.env.DATABASE_URL) {
    console.log("Status: Переменная DATABASE_URL найдена на хостинге!");
} else {
    console.log("Status: ВНИМАНИЕ! Переменная DATABASE_URL отсутствует в настройках Render!");
}
console.log("===============================");

const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
}) : null;

// Тестовая проверка пула при запуске
if (pool) {
    pool.query('SELECT NOW()')
        .then(() => console.log("✓ УСПЕШНО: Прямое подключение к базе данных Supabase установлено!"))
        .catch((err) => console.error("❌ ОШИБКА ПОДКЛЮЧЕНИЯ К ПОСТГРЕСУ:", err.message));
}

// 1. ПОСТБЭК ЭНДПОИНТ (ПРИЕМ НАЧИСЛЕНИЙ)
app.get('/api/postback', async (req, res) => {
    try {
        const { user_id, amount, trans_id, secret } = req.query;

        if (!user_id || !amount || !trans_id) {
            return res.status(400).send('Missing required parameters');
        }

        const MONLIX_SECRET = process.env.MONLIX_SECRET || 'any';
        if (secret && secret !== MONLIX_SECRET) {
            return res.status(403).send('Invalid secret');
        }

        const amountUsd = parseFloat(amount);
        const usdToUser = amountUsd * 0.60; 
        const tonAmount = parseFloat((usdToUser / 5.20).toFixed(4)); 

        if (!pool) {
            console.log(`[DEV MODE] User: ${user_id} | +${tonAmount} TON`);
            return res.send('OK');
        }

        const targetUserId = parseInt(user_id, 10);

        // 1. Защита от дубликатов транзакций
        const txCheck = await pool.query('SELECT transaction_id FROM completed_offers WHERE transaction_id = \$1', [trans_id]);
        if (txCheck.rows.length > 0) {
            return res.send('OK'); 
        }

        // 2. Обновляем или создаем пользователя (UPSERT)
        await pool.query(`
            INSERT INTO users (telegram_id, balance_ton, updated_at) 
            VALUES ($1, $2, NOW())
            ON CONFLICT (telegram_id) 
            DO UPDATE SET balance_ton = users.balance_ton + $2, updated_at = NOW()
        `, [targetUserId, tonAmount]);

        // 3. Логируем транзакцию
        await pool.query(`
            INSERT INTO completed_offers (telegram_id, transaction_id, amount_usd, amount_ton) 
            VALUES ($1, $2, $3, $4)
        `, [targetUserId, trans_id, amountUsd, tonAmount]);

        console.log(`[DATABASE SUCCESS] ID: ${targetUserId} | TON: +${tonAmount}`);
        res.send('OK');

    } catch (error) {
        console.error('[POSTBACK ERROR]', error);
        res.status(500).send('ERROR');
    }
});

// 2. ЭНДПОИНТ ДЛЯ ПОЛУЧЕНИЯ БАЛАНСА В МИНИ-ПРИЛОЖЕНИИ
app.get('/api/user-balance', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });

        if (!pool) {
            return res.json({ telegram_id: parseInt(userId, 10), balance_ton: 0.5000 });
        }

        const targetUserId = parseInt(userId, 10);

        const userCheck = await pool.query('SELECT balance_ton FROM users WHERE telegram_id = \$1', [targetUserId]);
        
        const balance = userCheck.rows.length > 0 ? parseFloat(userCheck.rows[0].balance_ton) : 0.0000;

        res.json({
            telegram_id: targetUserId,
            balance_ton: balance
        });
    } catch (error) {
        console.error('[BALANCE FETCH ERROR]', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
