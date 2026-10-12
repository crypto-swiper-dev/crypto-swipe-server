import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// Включаем CORS и автоматическую раздачу фронтенда из папки public
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Настройки Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MONLIX_SECRET = process.env.MONLIX_SECRET || 'any';

const supabase = (SUPABASE_URL && SUPABASE_KEY) 
  ? createClient(SUPABASE_URL, SUPABASE_KEY) 
  : null;

// 1. POSTBACK ЭНДПОИНТ ДЛЯ MONLIX
app.get('/api/postback', async (req, res) => {
    try {
        const { user_id, amount, trans_id, secret } = req.query;

        // Проверка обязательных параметров
        if (!user_id || !amount || !trans_id) {
            return res.status(400).send('Missing required parameters');
        }

        // Проверка секрета
        if (secret && secret !== MONLIX_SECRET) {
            return res.status(403).send('Invalid secret');
        }

        const amountUsd = parseFloat(amount);
        const usdToUser = amountUsd * 0.60; // 40% комиссия админа
        const tonAmount = parseFloat((usdToUser / 5.20).toFixed(4)); // Курс 5.20

        if (!supabase) {
            console.log(`[LOCAL TEST SUCCESS] User: ${user_id} | +${tonAmount} TON`);
            return res.send('OK');
        }

        // Защита от дубликатов трансляций
        const { data: existingTx } = await supabase
            .from('completed_offers')
            .select('transaction_id')
            .eq('transaction_id', trans_id)
            .single();

        if (existingTx) {
            return res.send('OK'); // Уже начислено, просто возвращаем OK
        }

        // Получаем текущий баланс пользователя
        const { data: user } = await supabase
            .from('users')
            .select('balance_ton')
            .eq('telegram_id', user_id)
            .single();

        const currentBalance = user ? parseFloat(user.balance_ton) : 0.0;
        const newBalance = currentBalance + tonAmount;

        // Обновляем баланс пользователя через UPSERT
        await supabase
            .from('users')
            .upsert({ telegram_id: user_id, balance_ton: newBalance, updated_at: new Date() });

        // Логируем успешную транзакцию
        await supabase
            .from('completed_offers')
            .insert({
                telegram_id: user_id,
                transaction_id: trans_id,
                amount_usd: amountUsd,
                amount_ton: tonAmount
            });

        console.log(`[POSTBACK SUCCESS] ID: ${user_id} | Tx: ${trans_id} | TON: +${tonAmount}`);
        res.send('OK');

    } catch (error) {
        console.error('[POSTBACK ERROR]', error);
        res.status(500).send('ERROR');
    }
});

// 2. ЭНДПОИНТ ПОЛУЧЕНИЯ БАЛАНСА ПОЛЬЗОВАТЕЛЯ
app.get('/api/user-balance', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });

        if (!supabase) {
            return res.json({ telegram_id: userId, balance_ton: 0.5000 });
        }

        const { data: user } = await supabase
            .from('users')
            .select('balance_ton')
            .eq('telegram_id', userId)
            .single();

        res.json({
            telegram_id: userId,
            balance_ton: user ? user.balance_ton : 0.0000
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
