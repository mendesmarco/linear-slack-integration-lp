const express = require('express');

const app = express();
app.use(express.json());

// Teste básico - sem dependências externas
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        message: 'Servidor funcionando!'
    });
});

app.post('/webhook/linear', (req, res) => {
    console.log('Webhook recebido:', req.body);
    res.status(200).send('OK');
});

app.post('/slack/commands/create-task', (req, res) => {
    console.log('Comando Slack recebido:', req.body);
    res.json({
        response_type: 'in_channel',
        text: 'Servidor funcionando! (tokens de teste)'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`✅ Teste básico funcionando!`);
});