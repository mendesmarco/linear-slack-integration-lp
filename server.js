const express = require('express');
const { WebClient } = require('@slack/web-api');
const { LinearClient } = require('@linear/sdk');

const app = express();
app.use(express.json());

// Configurações
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-your-slack-bot-token';
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || 'lin_api_your-linear-api-key';

const slack = new WebClient(SLACK_BOT_TOKEN);
const linear = new LinearClient({ apiKey: LINEAR_API_KEY });

const issueThreadMap = new Map();

// Comando Slack com MUITO debug
app.post('/slack/commands/create-task', async (req, res) => {
    try {
        // LOG COMPLETO do que chegou
        console.log('=== COMANDO SLACK RECEBIDO ===');
        console.log('Body completo:', JSON.stringify(req.body, null, 2));
        console.log('req.body.text:', req.body.text);
        console.log('Tipo do text:', typeof req.body.text);
        console.log('Length do text:', req.body.text ? req.body.text.length : 'undefined');
        console.log('Text após trim:', req.body.text ? `"${req.body.text.trim()}"` : 'undefined');
        console.log('================================');

        const { text, user_id, channel_id } = req.body;
        
        // Validação com mais detalhes
        if (!text) {
            console.log('❌ Erro: text é undefined/null');
            return res.json({
                response_type: 'ephemeral',
                text: 'DEBUG: Campo text está undefined/null. Por favor tente: `/create-task Implementar nova feature`'
            });
        }
        
        if (text.trim() === '') {
            console.log('❌ Erro: text está vazio após trim');
            return res.json({
                response_type: 'ephemeral',
                text: 'DEBUG: Campo text está vazio. Por favor tente: `/create-task Implementar nova feature`'
            });
        }

        console.log('✅ Validação passou! Text:', `"${text.trim()}"`);

        // Resposta imediata
        res.json({
            response_type: 'in_channel',
            text: `✅ DEBUG: Criando tarefa: "${text.trim()}"... (Length: ${text.trim().length})`
        });

        // Obter informações do usuário
        const userInfo = await slack.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;

        // Obter teams do Linear
        const teams = await linear.teams();
        const firstTeam = teams.nodes[0];

        if (!firstTeam) {
            await slack.chat.postMessage({
                channel: channel_id,
                text: '❌ Erro: Nenhum team encontrado no Linear. Configure ao menos um team primeiro.'
            });
            return;
        }

        // Criar issue no Linear
        const issuePayload = await linear.createIssue({
            teamId: firstTeam.id,
            title: text.trim(),
            description: `Criada via Slack por ${userName}`
        });

        const issue = await issuePayload.issue;
        
        if (issue) {
            // Enviar mensagem no Slack com detalhes da tarefa
            const message = await slack.chat.postMessage({
                channel: channel_id,
                text: `✅ Tarefa criada com sucesso!`,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*Tarefa criada no Linear:*\n*Título:* ${issue.title}\n*ID:* ${issue.identifier}\n*Status:* ${issue.state?.name || 'Backlog'}`
                        }
                    },
                    {
                        type: 'actions',
                        elements: [
                            {
                                type: 'button',
                                text: {
                                    type: 'plain_text',
                                    text: 'Ver no Linear'
                                },
                                url: issue.url
                            }
                        ]
                    }
                ]
            });

            // Salvar mapeamento
            issueThreadMap.set(issue.id, {
                channel: channel_id,
                ts: message.ts,
                issueId: issue.id,
                identifier: issue.identifier
            });

            console.log(`✅ Tarefa ${issue.identifier} criada e mapeada!`);
        }

    } catch (error) {
        console.error('❌ ERRO COMPLETO:', error);
        
        try {
            await slack.chat.postMessage({
                channel: req.body.channel_id,
                text: `❌ Erro ao criar tarefa: ${error.message}`
            });
        } catch (slackError) {
            console.error('❌ Erro ao enviar mensagem de erro:', slackError);
        }
    }
});

// Webhook do Linear (inalterado)
app.post('/webhook/linear', async (req, res) => {
    try {
        const { type, data } = req.body;
        console.log('Webhook Linear recebido:', type);

        if (type === 'Issue' && data) {
            const issue = data;
            const threadInfo = issueThreadMap.get(issue.id);

            if (threadInfo) {
                let updateText = '';
                let emoji = '🔄';

                if (issue.state) {
                    const stateName = issue.state.name;
                    if (stateName.toLowerCase().includes('done') || stateName.toLowerCase().includes('completed')) {
                        emoji = '✅';
                        updateText = `*Status atualizado para:* ${stateName}`;
                    } else if (stateName.toLowerCase().includes('progress') || stateName.toLowerCase().includes('doing')) {
                        emoji = '🚀';
                        updateText = `*Status atualizado para:* ${stateName}`;
                    } else {
                        updateText = `*Status atualizado para:* ${stateName}`;
                    }
                }

                if (issue.assignee) {
                    updateText += `\n*Assignee:* ${issue.assignee.name}`;
                }

                await slack.chat.postMessage({
                    channel: threadInfo.channel,
                    thread_ts: threadInfo.ts,
                    text: `${emoji} *Tarefa ${threadInfo.identifier} atualizada:*\n${updateText}`,
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: `${emoji} *Tarefa ${threadInfo.identifier} atualizada:*\n${updateText}`
                            }
                        },
                        {
                            type: 'context',
                            elements: [
                                {
                                    type: 'mrkdwn',
                                    text: `<${issue.url}|Ver no Linear> | Atualizado em ${new Date().toLocaleString('pt-BR')}`
                                }
                            ]
                        }
                    ]
                });

                console.log(`Atualização enviada para thread ${threadInfo.ts}`);
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Erro no webhook:', error);
        res.status(500).send('Erro interno');
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        mappedIssues: issueThreadMap.size,
        timestamp: new Date().toISOString()
    });
});

// Debug mappings
app.get('/debug/mappings', (req, res) => {
    const mappings = Array.from(issueThreadMap.entries()).map(([id, info]) => ({
        issueId: id,
        ...info
    }));
    res.json(mappings);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📡 Webhook Linear: http://localhost:${PORT}/webhook/linear`);
    console.log(`⚡ Comando Slack: http://localhost:${PORT}/slack/commands/create-task`);
});