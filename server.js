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
app.use(express.json());

// Раздача тестовой страницы
app.get('/test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// Раздача фронтенда
app.use(express.static('public'));

// Официальное подключение Supabase через URL и сервисный ключ API
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) 
  ? createClient(SUPABASE_URL, SUPABASE_KEY) 
  : null;

console.log("=== ДИАГНОСТИКА СВЯЗИ ===");
if (supabase) {
    console.log("✓ Официальный клиент Supabase успешно запущен!");
} else {
    console.log("❌ ВНИМАНИЕ: Проверьте переменные SUPABASE_URL и SUPABASE_KEY!");
}
console.log("=========================");

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

        // 1. Защита от дубликатов транзакций
        const { data: existingTx } = await supabase
            .from('completed_offers')
            .select('transaction_id')
            .eq('transaction_id', trans_id)
            .maybeSingle();

        if (existingTx) {
            return res.send('OK'); 
        }

        // 2. Чтение текущего баланса
        const { data: user } = await supabase
            .from('users')
            .select('balance_ton')
            .eq('telegram_id', targetUserId)
            .maybeSingle();

        const currentBalance = user ? parseFloat(user.balance_ton) : 0.0;
        const newBalance = currentBalance + tonAmount;

        // 3. Сохранение баланса (UPSERT)
        await supabase
            .from('users')
            .upsert({ telegram_id: targetUserId, balance_ton: newBalance, updated_at: new Date() });

        // 4. Логирование транзакции
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

// 2. ЭНДПОИНТ ДЛЯ ПОЛУЧЕНИЯ БАЛАНСА В МИНИ-ПРИЛОЖЕНИИ
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

        const balance = user ? parseFloat(user.balance_ton) : 0.0000;

        return res.json({
            telegram_id: targetUserId,
            balance_ton: balance
        });
    } catch (error) {
        console.error('[BALANCE FETCH ERROR]', error);
        return res.status(500).json({ error: 'Internal error' });
    }
});

app.listen(PORT, () => {
    console.log('Server is listening on port ' + PORT);
});
