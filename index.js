const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === 'true';

app.use(express.json());

// ---- 1. База данных и миграции ----
const dbPath = process.env.DB_PATH || path.join(__dirname, 'stats.db');
const db = new sqlite3.Database(dbPath);

// Таблица closes (подробные закрытия)
db.run(
    'CREATE TABLE IF NOT EXISTS closes (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'operator_email TEXT NOT NULL,' +
    'dialog_number INTEGER,' +
    'conversation_id TEXT NOT NULL,' +
    'closed_at TEXT NOT NULL,' +
    'queue_name TEXT,' +
    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
    ')'
);

// Таблица chat_events (назначения и короткие закрытия)
db.run(
    'CREATE TABLE IF NOT EXISTS chat_events (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'event_type TEXT NOT NULL,' +
    'operator_name TEXT NOT NULL,' +
    'conversation_id TEXT NOT NULL,' +
    'occurred_at TEXT NOT NULL,' +
    'queue_name TEXT,' +
    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
    ')'
);

// Миграция: добавляем колонку queue_name в closes, если её нет
db.all('PRAGMA table_info(closes)', (err, columns) => {
    if (!err && columns && Array.isArray(columns)) {
        const hasQueue = columns.some(col => col.name === 'queue_name');
        if (!hasQueue) {
            db.run('ALTER TABLE closes ADD COLUMN queue_name TEXT', (err) => {
                if (err) console.error('Ошибка миграции closes:', err);
                else console.log('✅ Добавлена queue_name в closes');
            });
        }
    }
});

// Миграция для chat_events
db.all('PRAGMA table_info(chat_events)', (err, columns) => {
    if (!err && columns && Array.isArray(columns)) {
        const hasQueue = columns.some(col => col.name === 'queue_name');
        if (!hasQueue) {
            db.run('ALTER TABLE chat_events ADD COLUMN queue_name TEXT', (err) => {
                if (err) console.error('Ошибка миграции chat_events:', err);
                else console.log('✅ Добавлена queue_name в chat_events');
            });
        }
    }
});

// ---- 2. Форматирование времени (МСК) ----
function formatToMoscowTime(utcString) {
    let cleaned = utcString;
    if (cleaned.includes('+')) {
        cleaned = cleaned.split('+')[0];
    }
    if (cleaned.includes('Z')) {
        cleaned = cleaned.replace('Z', '');
    }
    const date = new Date(cleaned);
    if (isNaN(date.getTime())) {
        return { date: '00.00.0000', time: '00:00:00' };
    }
    const moscowTime = new Date(date.getTime() + 3 * 60 * 60 * 1000);
    const day = String(moscowTime.getUTCDate()).padStart(2, '0');
    const month = String(moscowTime.getUTCMonth() + 1).padStart(2, '0');
    const year = moscowTime.getUTCFullYear();
    const hours = String(moscowTime.getUTCHours()).padStart(2, '0');
    const minutes = String(moscowTime.getUTCMinutes()).padStart(2, '0');
    const seconds = String(moscowTime.getUTCSeconds()).padStart(2, '0');
    return { date: day + '.' + month + '.' + year, time: hours + ':' + minutes + ':' + seconds };
}

// ---- 3. Отправка сообщений в Telegram ----
async function sendTelegramMessage(chatId, text, options = {}) {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '7258788827:AAHLAZK1vdJOGj_6AAqE9W6B5vUd7mUUJ_4';
    const url = 'https://api.telegram.org/bot' + telegramToken + '/sendMessage';
    const payload = { chat_id: chatId, text: text, ...options };
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error('Ошибка отправки в Telegram:', e);
    }
}

// ---- 4. Получение уникальных дат (МСК) из closes ----
function getUniqueMoscowDates(callback) {
    db.all('SELECT closed_at FROM closes WHERE closed_at IS NOT NULL', [], (err, rows) => {
        if (err) return callback(err, null);
        const datesSet = new Set();
        for (const row of rows) {
            const { date } = formatToMoscowTime(row.closed_at);
            if (date !== '00.00.0000') datesSet.add(date);
        }
        const sortedDates = Array.from(datesSet).sort((a, b) => {
            const [da, ma, ya] = a.split('.');
            const [db, mb, yb] = b.split('.');
            return new Date(ya, ma-1, da) - new Date(yb, mb-1, db);
        }).reverse();
        callback(null, sortedDates);
    });
}

// ---- 5. Вебхук ----
app.post('/webhook', async (req, res) => {
    try {
        const payload = req.body;
        const event = payload.event;
        const data = payload.data || {};
        const timestamp = payload.timestamp;
        if (DEBUG) console.log('Webhook event: ' + event + ', timestamp: ' + timestamp);

        // --- chat.assigned ---
        if (event === 'chat.assigned') {
            const operator_name = data.operator_name;
            const conversation_id = data.conversation_id;
            const queueName = (data.queue && data.queue.name) || '';
            if (!operator_name || !conversation_id || !timestamp) {
                console.error('Неполные данные для chat.assigned');
                return res.status(200).send('Missing data');
            }
            db.run(
                'INSERT INTO chat_events (event_type, operator_name, conversation_id, occurred_at, queue_name) VALUES (?, ?, ?, ?, ?)',
                ['assigned', operator_name, conversation_id, timestamp, queueName],
                (err) => { if (err) console.error('Ошибка сохранения назначения:', err); }
            );
            const { date, time } = formatToMoscowTime(timestamp);
            const queuePrefix = queueName ? queueName + ' ' : '';
            const message = queuePrefix + operator_name + ' ' + conversation_id + ' назначен ' + date + ' ' + time;
            const assignedChatId = process.env.ASSIGNED_CHAT_ID || '-1003699948179';
            await sendTelegramMessage(assignedChatId, message);
            return res.status(200).send('OK');
        }

        // --- chat.closed ---
        if (event === 'chat.closed') {
            const isDetailed = data.conversation && data.operator && data.close_info;
            if (isDetailed) {
                const conversation = data.conversation;
                const operator = data.operator;
                const queue = data.queue || {};
                const queueName = queue.name || '';
                const dialogNumber = conversation.dialog_number;
                const conversationId = conversation.id;
                const operatorEmail = operator.email;
                const closedAtUTC = conversation.closed_at;
                db.run(
                    'INSERT INTO closes (operator_email, dialog_number, conversation_id, closed_at, queue_name) VALUES (?, ?, ?, ?, ?)',
                    [operatorEmail, dialogNumber, conversationId, closedAtUTC, queueName],
                    (err) => { if (err) console.error('Ошибка сохранения в БД:', err); }
                );
                const { date, time } = formatToMoscowTime(closedAtUTC);
                const chatLink = 'https://chat.moneyman.ru/operator/chat/' + conversationId;
                const queuePrefix = queueName ? queueName + ' ' : '';
                const messageHtml = '<a href="' + chatLink + '">' + queuePrefix + '№' + dialogNumber + '</a> ' + operatorEmail + ' закрыт ' + date + ' ' + time;
                const notifyChatId = process.env.NOTIFY_CHAT_ID || '-1003330015301';
                await sendTelegramMessage(notifyChatId, messageHtml, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
                return res.status(200).send('OK');
            } else {
                // Короткое закрытие
                const operator_name = data.operator_name;
                const conversation_id = data.conversation_id;
                const queue = data.queue || {};
                const queueName = queue.name || '';
                if (!operator_name || !conversation_id || !timestamp) {
                    console.error('Неполные данные для короткого закрытия');
                    return res.status(200).send('Missing data');
                }
                db.run(
                    'INSERT INTO chat_events (event_type, operator_name, conversation_id, occurred_at, queue_name) VALUES (?, ?, ?, ?, ?)',
                    ['closed_short', operator_name, conversation_id, timestamp, queueName],
                    (err) => { if (err) console.error('Ошибка сохранения короткого закрытия:', err); }
                );
                const { date, time } = formatToMoscowTime(timestamp);
                const queuePrefix = queueName ? queueName + ' ' : '';
                const message = queuePrefix + operator_name + ' ' + conversation_id + ' закрыт ' + date + ' ' + time;
                const assignedChatId = process.env.ASSIGNED_CHAT_ID || '-1003699948179';
                await sendTelegramMessage(assignedChatId, message);
                return res.status(200).send('OK');
            }
        }

        res.status(200).send('Ignored');
    } catch (error) {
        console.error('Ошибка при обработке вебхука:', error);
        res.status(200).send('Error logged');
    }
});

// ---- 6. Обработка команд Telegram ----
app.post('/telegram-webhook', async (req, res) => {
    try {
        const update = req.body;

        // ---- Callback Query (нажатие на inline-кнопку) ----
        if (update.callback_query) {
            const callback = update.callback_query;
            const chatId = callback.message.chat.id;
            const data = callback.data;
            const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '7258788827:AAHLAZK1vdJOGj_6AAqE9W6B5vUd7mUUJ_4';

            fetch('https://api.telegram.org/bot' + telegramToken + '/answerCallbackQuery', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: callback.id })
            }).catch(e => console.error('Ошибка answerCallbackQuery:', e));

            if (data.startsWith('stats_date:')) {
                const selectedDate = data.split(':')[1];
                db.all('SELECT queue_name, operator_email, closed_at FROM closes', [], (err, rows) => {
                    if (err) {
                        sendTelegramMessage(chatId, '❌ Ошибка получения данных.');
                        return;
                    }
                    const filtered = [];
                    for (const row of rows) {
                        const { date } = formatToMoscowTime(row.closed_at);
                        if (date === selectedDate) {
                            filtered.push(row);
                        }
                    }
                    if (filtered.length === 0) {
                        sendTelegramMessage(chatId, '📊 За ' + selectedDate + ' данных нет.');
                        return;
                    }
                    const groups = {};
                    for (const row of filtered) {
                        const qname = row.queue_name || 'Без канала';
                        const op = row.operator_email;
                        if (!groups[qname]) groups[qname] = {};
                        groups[qname][op] = (groups[qname][op] || 0) + 1;
                    }
                    const order = [
                        'Support PLZ: Chat',
                        'Support MM: Email',
                        'Support MM: Chat',
                        'Collection MM: Chat',
                        'Collection PLZ: Chat',
                        'Без канала'
                    ];
                    let message = '📊 *Статистика за ' + selectedDate + '*\n\n';
                    let hasData = false;
                    for (const qname of order) {
                        const ops = groups[qname];
                        if (!ops) continue;
                        hasData = true;
                        message += '*' + qname + ':*\n';
                        const sortedOps = Object.entries(ops).sort((a,b) => b[1] - a[1]);
                        sortedOps.forEach(([op, count], idx) => {
                            message += (idx+1) + '. ' + op + ' — *' + count + '*\n';
                        });
                        message += '\n';
                    }
                    if (!hasData) message = '📊 За ' + selectedDate + ' данных нет.';
                    sendTelegramMessage(chatId, message, { parse_mode: 'Markdown' });
                });
            }
            return res.status(200).send('OK');
        }

        // ---- Обычное сообщение ----
        if (!update.message) return res.status(200).send('OK');
        const chatId = update.message.chat.id;
        const text = update.message.text || '';
        if (DEBUG) console.log('Telegram command: ' + text + ' from chat ' + chatId);

        const notifyChatId = process.env.NOTIFY_CHAT_ID || '-1003330015301';
        const assignedChatId = process.env.ASSIGNED_CHAT_ID || '-1003699948179';
        const adminId = parseInt(process.env.ADMIN_ID || '241380306', 10);

        // --- /stats ---
        if (text === '/stats') {
            if (chatId.toString() === notifyChatId) {
                getUniqueMoscowDates((err, dates) => {
                    if (err || !dates.length) {
                        sendTelegramMessage(chatId, '❌ Нет данных для отображения.');
                        return;
                    }
                    const keyboard = {
                        inline_keyboard: [ dates.map(date => ({ text: date, callback_data: 'stats_date:' + date })) ]
                    };
                    sendTelegramMessage(chatId, '📅 Выберите дату:', {
                        reply_markup: JSON.stringify(keyboard)
                    });
                });
            } else if (chatId.toString() === assignedChatId) {
                // Статистика для назначений и коротких закрытий (без выбора даты)
                const query = [
                    'SELECT event_type, queue_name, operator_name, COUNT(*) as count',
                    'FROM chat_events',
                    'WHERE queue_name IS NOT NULL AND queue_name != ""',
                    'GROUP BY event_type, queue_name, operator_name',
                    'ORDER BY',
                    'CASE event_type WHEN "assigned" THEN 1 ELSE 2 END,',
                    'CASE queue_name',
                        'WHEN "Support PLZ: Chat" THEN 1',
                        'WHEN "Support MM: Email" THEN 2',
                        'WHEN "Support MM: Chat" THEN 3',
                        'WHEN "Collection MM: Chat" THEN 4',
                        'WHEN "Collection PLZ: Chat" THEN 5',
                        'ELSE 6',
                    'END,',
                    'count DESC'
                ].join(' ');
                db.all(query, [], (err, rows) => {
                    if (err) {
                        console.error('Ошибка получения статистики (chat_events):', err);
                        sendTelegramMessage(chatId, '❌ Ошибка при получении статистики.');
                        return;
                    }
                    if (rows.length === 0) {
                        sendTelegramMessage(chatId, '📊 Статистика по событиям чата пуста.');
                        return;
                    }
                    const assignedGroups = {};
                    const closedGroups = {};
                    for (const row of rows) {
                        const target = row.event_type === 'assigned' ? assignedGroups : closedGroups;
                        if (!target[row.queue_name]) target[row.queue_name] = [];
                        target[row.queue_name].push({ operator: row.operator_name, count: row.count });
                    }
                    const order = [
                        'Support PLZ: Chat',
                        'Support MM: Email',
                        'Support MM: Chat',
                        'Collection MM: Chat',
                        'Collection PLZ: Chat'
                    ];
                    let finalMessage = '';
                    if (Object.keys(assignedGroups).length) {
                        finalMessage += '📊 *Назначено:*\n\n';
                        for (const qname of order) {
                            const ops = assignedGroups[qname];
                            if (!ops) continue;
                            finalMessage += '*' + qname + ':*\n';
                            ops.forEach((op, idx) => {
                                finalMessage += (idx+1) + '. ' + op.operator + ' — *' + op.count + '*\n';
                            });
                            finalMessage += '\n';
                        }
                    }
                    if (Object.keys(closedGroups).length) {
                        finalMessage += '📊 *Закрыто (короткие события):*\n\n';
                        for (const qname of order) {
                            const ops = closedGroups[qname];
                            if (!ops) continue;
                            finalMessage += '*' + qname + ':*\n';
                            ops.forEach((op, idx) => {
                                finalMessage += (idx+1) + '. ' + op.operator + ' — *' + op.count + '*\n';
                            });
                            finalMessage += '\n';
                        }
                    }
                    sendTelegramMessage(chatId, finalMessage.trim(), { parse_mode: 'Markdown' });
                });
            } else {
                sendTelegramMessage(chatId, '❌ Команда /stats доступна только в специальных чатах.');
            }
            return res.status(200).send('OK');
        }

        // --- /clear_stats ---
        if (text === '/clear_stats') {
            if (chatId !== adminId) {
                sendTelegramMessage(chatId, '⛔ Недостаточно прав для очистки статистики.');
                return res.status(200).send('OK');
            }
            db.serialize(() => {
                db.run('DELETE FROM closes');
                db.run('DELETE FROM chat_events');
            });
            sendTelegramMessage(chatId, '✅ Статистика полностью очищена (обе таблицы).');
            return res.status(200).send('OK');
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Ошибка обработки команды Telegram:', error);
        res.status(200).send('OK');
    }
});

// ---- 7. Запуск сервера и установка вебхука Telegram ----
app.listen(port, async () => {
    console.log('Бот слушает вебхуки на порту ' + port);
    const publicUrl = process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
    if (!publicUrl) {
        console.warn('PUBLIC_URL не задан, вебхук Telegram не будет установлен автоматически.');
        return;
    }
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '7258788827:AAHLAZK1vdJOGj_6AAqE9W6B5vUd7mUUJ_4';
    const webhookUrl = 'https://' + publicUrl + '/telegram-webhook';
    const setWebhookUrl = 'https://api.telegram.org/bot' + telegramToken + '/setWebhook?url=' + webhookUrl;
    try {
        const response = await fetch(setWebhookUrl);
        const result = await response.json();
        if (result.ok) console.log('Вебхук для Telegram успешно установлен:', webhookUrl);
        else console.error('Ошибка установки вебхука Telegram:', result);
    } catch (error) {
        console.error('Не удалось установить вебхук Telegram:', error);
    }
});