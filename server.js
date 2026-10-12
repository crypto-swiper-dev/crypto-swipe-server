import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json()); // ВАЖНО: Разрешаем серверу парсить JSON в теле POST-запросов

app.get('/test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

app.use(express.static('public'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) 
  ? createClient(SUPABASE_URL, SUPABASE_KEY) 
  : null;

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

        if (!supabase) {
            console.log(`[DEV MODE] User: ${user_id} | +${tonAmount} TON`);
            return res.send('OK');
        }

        const targetUserId = parseInt(user_id, 10);

        const { data: existingTx } = await supabase
            .from('completed_offers')
            .select('transaction_id')
            .eq('transaction_id', trans_id)
            .maybeSingle();

        if (existingTx) { return res.send('OK'); }

        const { data: user } = await supabase
            .from('users')
            .select('balance_ton')
            .eq('telegram_id', targetUserId)
            .maybeSingle();

        const currentBalance = user ? parseFloat(user.balance_ton) : 0.0;
        const newBalance = currentBalance + tonAmount;

        await supabase
            .from('users')
            .upsert({ telegram_id: targetUserId, balance_ton: newBalance, updated_at: new Date() });

        await supabase
            .from('completed_offers')
            .insert({
                telegram_id: targetUserId,
                transaction_id: trans_id,
                amount_usd: amountUsd,
                amount_ton: tonAmount
            });

        console.log(`[DATABASE SUCCESS] ID: ${targetUserId} | TON: +${tonAmount}`);
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

        if (!supabase) {
            return res.json({ telegram_id: parseInt(userId, 10), balance_ton: 0.5000 });
        }

        const targetUserId = parseInt(userId, 10);
        const { data: user } = await supabase
            .from('users')
            .select('balance_ton')
            .eq('telegram_id', targetUserId)
            .maybeSingle();

        return res.json({
            telegram_id: targetUserId,
            balance_ton: user ? parseFloat(user.balance_ton) : 0.0000
        });
    } catch (error) {
        return res.status(500).json({ error: 'Internal error' });
    }
});

// 🚀 3. НОВЫЙ ЭНДПОИНТ: ОБРАБОТКА ВЫВОДА СРЕДСТВ
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, walletAddress, amount } = req.body;

        if (!userId || !walletAddress || !amount) {
            return res.status(400).json({ success: false, error: 'Missing parameters' });
        }

        if (!supabase) {
            return res.json({ success: true, message: '[DEV MODE] Withdrawal simulation successful' });
        }

        const targetUserId = parseInt(userId, 10);
        const withdrawAmount = parseFloat(amount);

        // Проверяем реальный баланс юзера в базе
        const { data: user } = await supabase
            .from('users')
            .select('balance_ton')
            .eq('telegram_id', targetUserId)
            .maybeSingle();

        if (!user || parseFloat(user.balance_ton) < withdrawAmount || withdrawAmount < 0.5000) {
            return res.status(400).json({ success: false, error: 'Недостаточно средств или неверная сумма' });
        }

        // Списываем баланс до 0 в таблице users
        const newBalance = parseFloat(user.balance_ton) - withdrawAmount;
        await supabase
            .from('users')
            .update({ balance_ton: newBalance, updated_at: new Date() })
            .eq('telegram_id', targetUserId);

        // Записываем лог заявки в таблицу withdrawal_requests
        await supabase
            .from('withdrawal_requests')
            .insert({
                telegram_id: targetUserId,
                wallet_address: walletAddress,
                amount_ton: withdrawAmount,
                status: 'pending'
            });

        console.log(`[WITHDRAW REQUEST] ID: ${targetUserId} | Amount: ${withdrawAmount} TON | Wallet: ${walletAddress}`);
        return res.json({ success: true });

    } catch (error) {
        console.error('[WITHDRAW ERROR]', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.listen(PORT, () => {
    console.log('Server is listening on port ' + PORT);
});
