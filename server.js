const express = require('express');
const { WebClient } = require('@slack/web-api');
const { LinearClient } = require('@linear/sdk');

const app = express();
app.use(express.json());

// Configurações - substitua pelos seus tokens
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-your-slack-bot-token';
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || 'lin_api_your-linear-api-key';

const slack = new WebClient(SLACK_BOT_TOKEN);
const linear = new LinearClient({ apiKey: LINEAR_API_KEY });

// Armazenar mapeamento entre issues do Linear e threads do Slack
// Em produção, use um banco de dados
const issueThreadMap = new Map();

// Comando Slack para criar tarefa no Linear
app.post('/slack/commands/create-task', async (req, res) => {
    try {
        const { text, user_id, channel_id } = req.body;
        
        // Validar se tem texto
        if (!text || text.trim() === '') {
            return res.json({
                response_type: 'ephemeral',
                text: 'Por favor, forneça um título para a tarefa. Exemplo: `/create-task Implementar nova feature`'
            });
        }

        // Resposta imediata para o Slack
        res.json({
            response_type: 'in_channel',
            text: `Criando tarefa: "${text}"...`
        });

        // Obter informações do usuário
        const userInfo = await slack.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;

        // Obter teams do Linear (precisamos de um team para criar a issue)
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

            // Salvar mapeamento issue -> thread
            issueThreadMap.set(issue.id, {
                channel: channel_id,
                ts: message.ts,
                issueId: issue.id,
                identifier: issue.identifier
            });

            console.log(`Tarefa ${issue.identifier} criada e mapeada para thread ${message.ts}`);
        }

    } catch (error) {
        console.error('Erro ao criar tarefa:', error);
        
        // Tentar enviar erro para o Slack
        try {
            await slack.chat.postMessage({
                channel: req.body.channel_id,
                text: `❌ Erro ao criar tarefa: ${error.message}`
            });
        } catch (slackError) {
            console.error('Erro ao enviar mensagem de erro:', slackError);
        }
    }
});

// Webhook para receber atualizações do Linear
app.post('/webhook/linear', async (req, res) => {
    try {
        const { type, data } = req.body;
        
        console.log('Webhook recebido:', type);

        // Processar apenas atualizações de issues
        if (type === 'Issue' && data) {
            const issue = data;
            const threadInfo = issueThreadMap.get(issue.id);

            if (threadInfo) {
                // Determinar tipo de atualização
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

                // Se tiver assignee
                if (issue.assignee) {
                    updateText += `\n*Assignee:* ${issue.assignee.name}`;
                }

                // Enviar atualização na thread
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

// Endpoint de saúde
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        mappedIssues: issueThreadMap.size,
        timestamp: new Date().toISOString()
    });
});

// Endpoint para listar mapeamentos (debug)
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