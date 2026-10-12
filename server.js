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

app.get('/test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

app.use(express.static('public'));

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
}) : null;

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
            console.log('[DEV MODE] User: ' + user_id + ' | +' + tonAmount + ' TON');
            return res.send('OK');
        }

        const targetUserId = parseInt(user_id, 10);

        const txCheck = await pool.query('SELECT transaction_id FROM completed_offers WHERE transaction_id = $1', [trans_id]);
        if (txCheck.rows.length > 0) {
            return res.send('OK'); 
        }

        const userUpsertQuery = 'INSERT INTO users (telegram_id, balance_ton, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (telegram_id) DO UPDATE SET balance_ton = users.balance_ton + $2, updated_at = NOW()';
        await pool.query(userUpsertQuery, [targetUserId, tonAmount]);

        const txInsertQuery = 'INSERT INTO completed_offers (telegram_id, transaction_id, amount_usd, amount_ton) VALUES ($1, $2, $3, $4)';
        await pool.query(txInsertQuery, [targetUserId, trans_id, amountUsd, tonAmount]);

        console.log('[DATABASE SUCCESS] ID: ' + targetUserId + ' | TON: +' + tonAmount);
        return res.send('OK');

    } catch (error) {
        console.error('[POSTBACK ERROR]', error);
        return res.status(500).send('ERROR');
    }
});

// 2. ЭНДПОИНТ ПОЛУЧЕНИЯ БАЛАНСА
app.get('/api/user-balance', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });

        if (!pool) {
            return res.json({ telegram_id: parseInt(userId, 10), balance_ton: 0.5000 });
        }

        const targetUserId = parseInt(userId, 10);
        const userCheck = await pool.query('SELECT balance_ton FROM users WHERE telegram_id = $1', [targetUserId]);
        
        let balance = 0.0000;
        // Чистый и безопасный способ чтения первой строки
        if (userCheck && userCheck.rows && userCheck.rows.length > 0) {
            const firstRow = userCheck.rows[0];
            if (firstRow && firstRow.balance_ton !== null) {
                balance = parseFloat(firstRow.balance_ton);
            }
        }

        return res.json({
            telegram_id: targetUserId,
            balance_ton: balance
        });
    } catch (error) {
        console.error('[BALANCE FETCH ERROR]', error);
        return res.status(500).json({ error: 'Internal error' });
    }
});

// 3. ЭНДПОИНТ ВЫВОДА СРЕДСТВ
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, walletAddress, amount } = req.body;

        if (!userId || !walletAddress || !amount) {
            return res.status(400).json({ success: false, error: 'Missing parameters' });
        }

        if (!pool) {
            return res.json({ success: true, message: '[DEV MODE]' });
        }

        const targetUserId = parseInt(userId, 10);
        const withdrawAmount = parseFloat(amount);

        const userCheck = await pool.query('SELECT balance_ton FROM users WHERE telegram_id = $1', [targetUserId]);

        if (!userCheck || userCheck.rows.length === 0) {
            return res.status(400).json({ success: false, error: 'Пользователь не найден' });
        }

        const firstRow = userCheck.rows[0];
        const userBalance = parseFloat(firstRow.balance_ton);

        if (userBalance < withdrawAmount || withdrawAmount < 0.5000) {
            return res.status(400).json({ success: false, error: 'Недостаточно средств' });
        }

        const newBalance = userBalance - withdrawAmount;
        await pool.query('UPDATE users SET balance_ton = $1, updated_at = NOW() WHERE telegram_id = $2', [newBalance, targetUserId]);

        // ИСПРАВЛЕНО: Убрали коварные косые слэши, заменив на чистые двойные кавычки вокруг "pending"
        await pool.query('INSERT INTO withdrawal_requests (telegram_id, wallet_address, amount_ton, status) VALUES ($1, $2, $3, "pending")', [targetUserId, walletAddress, withdrawAmount]);

        console.log('[WITHDRAW REQUEST] ID: ' + targetUserId + ' | TON: ' + withdrawAmount);
        return res.json({ success: true });

    } catch (error) {
        console.error('[WITHDRAW ERROR]', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.listen(PORT, () => {
    console.log('Server is listening on port ' + PORT);
});
