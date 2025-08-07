const express = require('express');
const { WebClient } = require('@slack/web-api');
const { LinearClient } = require('@linear/sdk');

const app = express();

app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-your-slack-bot-token';
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || 'lin_api_your-linear-api-key';

const slack = new WebClient(SLACK_BOT_TOKEN);
const linear = new LinearClient({ apiKey: LINEAR_API_KEY });

const issueThreadMap = new Map();

// Comando Slack - abre formulário
app.post('/slack/commands/create-task', async (req, res) => {
    try {
        const { trigger_id, channel_id, user_id } = req.body;

        console.log('✅ Comando recebido, abrindo formulário...');

        // Resposta imediata (obrigatória para slash commands)
        res.status(200).send();

        // Abrir modal com formulário personalizado
        await slack.views.open({
            trigger_id: trigger_id,
            view: {
                type: 'modal',
                callback_id: 'task_form_modal',
                title: {
                    type: 'plain_text',
                    text: 'Landing page request'
                },
                submit: {
                    type: 'plain_text',
                    text: 'Submit'
                },
                close: {
                    type: 'plain_text',
                    text: 'Close'
                },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'what_block',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'what_input',
                            placeholder: {
                                type: 'plain_text',
                                text: 'Write something'
                            }
                        },
                        label: {
                            type: 'plain_text',
                            text: 'O que é pra ser feito?'
                        },
                        hint: {
                            type: 'plain_text',
                            text: 'Cite de forma clara, objetiva e breve.'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'page_block',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'page_input',
                            placeholder: {
                                type: 'plain_text',
                                text: 'Write something'
                            }
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Em qual página?'
                        },
                        hint: {
                            type: 'plain_text',
                            text: 'Diga qual o slug da página (se for atual ou nova).'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'details_block',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'details_input',
                            multiline: true,
                            placeholder: {
                                type: 'plain_text',
                                text: 'Write something'
                            }
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Descreve melhor a demanda'
                        },
                        hint: {
                            type: 'plain_text',
                            text: 'Aqui coloque todos detalhes possíveis, link do docs, referências, infos de share, etc.'
                        }
                    }
                ],
                private_metadata: JSON.stringify({ channel_id, user_id })
            }
        });

        console.log('✅ Formulário aberto com sucesso');

    } catch (error) {
        console.error('❌ Erro ao abrir formulário:', error);
        
        try {
            await slack.chat.postMessage({
                channel: req.body.channel_id,
                text: `❌ Erro ao abrir formulário: ${error.message}`
            });
        } catch (slackError) {
            console.error('❌ Erro ao enviar mensagem de erro:', slackError);
        }
    }
});

// Processar submissão do formulário
app.post('/slack/interactivity', async (req, res) => {
    try {
        const payload = JSON.parse(req.body.payload);

        if (payload.type === 'view_submission' && payload.view.callback_id === 'task_form_modal') {
            console.log('✅ Formulário submetido');

            // Resposta imediata
            res.status(200).send();

            const { channel_id, user_id } = JSON.parse(payload.view.private_metadata);
            const values = payload.view.state.values;

            // Extrair dados do formulário
            const whatToDo = values.what_block.what_input.value; // TÍTULO da task
            const whichPage = values.page_block.page_input.value;
            const details = values.details_block.details_input.value;

            // Obter informações do usuário
            const userInfo = await slack.users.info({ user: user_id });
            const userName = userInfo.user.real_name || userInfo.user.name;

            // Buscar team Landing Pages
            let landingPagesTeam = null;
            let hasNextPage = true;
            let cursor = null;

            while (hasNextPage && !landingPagesTeam) {
                const teamsPage = await linear.teams({ 
                    first: 50,
                    after: cursor 
                });

                landingPagesTeam = teamsPage.nodes.find(team => 
                    team.name === 'Landing Pages' || 
                    team.key === 'LAN' ||
                    team.name.toLowerCase().includes('landing pages')
                );

                if (landingPagesTeam) break;

                hasNextPage = teamsPage.pageInfo.hasNextPage;
                cursor = teamsPage.pageInfo.endCursor;
            }

            if (!landingPagesTeam) {
                await slack.chat.postMessage({
                    channel: channel_id,
                    text: '❌ Erro: Team "Landing Pages" não encontrado.'
                });
                return;
            }

            // Criar descrição completa (página + detalhes)
            let fullDescription = `Criada via Slack por ${userName}\n\n`;
            fullDescription += `**Em qual página:** ${whichPage}\n\n`;
            fullDescription += `**Detalhes da demanda:**\n${details}`;

            // Criar issue no Linear
            const issuePayload = await linear.createIssue({
                teamId: landingPagesTeam.id,
                title: whatToDo, // O que é pra ser feito = TÍTULO
                description: fullDescription
            });

            const issue = await issuePayload.issue;
            
            if (issue) {
                // Enviar mensagem no Slack
                const message = await slack.chat.postMessage({
                    channel: channel_id,
                    text: `✅ Landing page request criado!`,
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: `*✅ Landing page request criado no Linear:*\n*O que fazer:* ${issue.title}\n*ID:* ${issue.identifier}\n*Status:* ${issue.state?.name || 'Backlog'}`
                            }
                        },
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: `*Em qual página:* ${whichPage}\n*Criado por:* ${userName}`
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
                                    url: issue.url,
                                    style: 'primary'
                                }
                            ]
                        }
                    ]
                });

                // Construir link da thread do Slack (voltando ao método original)
                const slackTeamInfo = await slack.team.info();
                const threadUrl = `https://${slackTeamInfo.team.domain}.slack.com/archives/${channel_id}/p${message.ts.replace('.', '')}`;

                // Atualizar descrição da issue com link da thread
                const updatedDescription = fullDescription + `\n\n**Thread no Slack:** ${threadUrl}`;
                
                await linear.updateIssue(issue.id, {
                    description: updatedDescription
                });

                console.log('✅ Link da thread adicionado na descrição:', threadUrl);

                // Salvar mapeamento
                issueThreadMap.set(issue.id, {
                    channel: channel_id,
                    ts: message.ts,
                    issueId: issue.id,
                    identifier: issue.identifier,
                    threadUrl: threadUrl
                });

                console.log(`✅ Landing page request ${issue.identifier} criado com formulário personalizado`);
            }
        }
        else {
            // Outras interações (botões, etc.)
            res.status(200).send();
        }

    } catch (error) {
        console.error('❌ Erro no processamento de interatividade:', error);
        res.status(200).send();
    }
});

// Webhook do Linear - com lógica de progresso
app.post('/webhook/linear', async (req, res) => {
    try {
        const { type, data, updatedFrom } = req.body;
        console.log('Webhook Linear recebido:', type);

        if (type === 'Issue' && data) {
            const issue = data;
            const threadInfo = issueThreadMap.get(issue.id);

            if (threadInfo && issue.state && updatedFrom && updatedFrom.state) {
                const currentState = issue.state.name.toLowerCase();
                const previousState = updatedFrom.state.name.toLowerCase();

                console.log(`Estado anterior: ${previousState} → Estado atual: ${currentState}`);

                // Definir ordem dos estados (esquerda para direita)
                const stateOrder = {
                    'todo': 1,
                    'to do': 1,
                    'backlog': 1,
                    'in progress': 2,
                    'doing': 2,
                    'in review': 3,
                    'review': 3,
                    'testing': 4,
                    'done': 5,
                    'completed': 5,
                    'closed': 5
                };

                // Função para obter posição do estado
                const getStatePosition = (stateName) => {
                    const normalizedState = stateName.toLowerCase().trim();
                    for (const [key, position] of Object.entries(stateOrder)) {
                        if (normalizedState.includes(key)) {
                            return position;
                        }
                    }
                    return 0; // Estado desconhecido
                };

                const previousPosition = getStatePosition(previousState);
                const currentPosition = getStatePosition(currentState);

                console.log(`Posição anterior: ${previousPosition}, Posição atual: ${currentPosition}`);

                // Só notificar se houve PROGRESSO (movimento para direita)
                if (currentPosition > previousPosition && previousPosition > 0 && currentPosition > 0) {
                    let emoji = '🚀';
                    
                    // Emojis específicos para cada transição
                    if (currentState.includes('progress') || currentState.includes('doing')) {
                        emoji = '🚀';
                    } else if (currentState.includes('review')) {
                        emoji = '👀';
                    } else if (currentState.includes('testing')) {
                        emoji = '🧪';
                    } else if (currentState.includes('done') || currentState.includes('completed')) {
                        emoji = '✅';
                    }

                    const updateText = `*Status atualizado para:* ${issue.state.name}`;

                    let additionalInfo = '';
                    if (issue.assignee) {
                        additionalInfo += `\n*Assignee:* ${issue.assignee.name}`;
                    }

                    await slack.chat.postMessage({
                        channel: threadInfo.channel,
                        thread_ts: threadInfo.ts,
                        text: `${emoji} *Tarefa ${threadInfo.identifier} progrediu:*\n${updateText}${additionalInfo}`,
                        blocks: [
                            {
                                type: 'section',
                                text: {
                                    type: 'mrkdwn',
                                    text: `${emoji} *Tarefa ${threadInfo.identifier} progrediu:*\n${updateText}${additionalInfo}`
                                }
                            },
                            {
                                type: 'context',
                                elements: [
                                    {
                                        type: 'mrkdwn',
                                        text: `<${issue.url}|Ver no Linear> | ${previousState} → ${issue.state.name} | ${new Date().toLocaleString('pt-BR')}`
                                    }
                                ]
                            }
                        ]
                    });

                    console.log(`✅ Notificação de progresso enviada: ${previousState} → ${currentState}`);
                } else {
                    console.log(`⏸️ Movimento não é progresso, não notificando: ${previousState} → ${currentState}`);
                }
            } else if (threadInfo && issue.assignee && updatedFrom && !updatedFrom.assignee) {
                // Notificar apenas quando alguém é ATRIBUÍDO pela primeira vez
                await slack.chat.postMessage({
                    channel: threadInfo.channel,
                    thread_ts: threadInfo.ts,
                    text: `👤 *Tarefa ${threadInfo.identifier} foi atribuída:*\n*Assignee:* ${issue.assignee.name}`,
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: `👤 *Tarefa ${threadInfo.identifier} foi atribuída:*\n*Assignee:* ${issue.assignee.name}`
                            }
                        },
                        {
                            type: 'context',
                            elements: [
                                {
                                    type: 'mrkdwn',
                                    text: `<${issue.url}|Ver no Linear> | Atribuído em ${new Date().toLocaleString('pt-BR')}`
                                }
                            ]
                        }
                    ]
                });

                console.log(`✅ Notificação de atribuição enviada para ${issue.assignee.name}`);
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
    console.log(`🔄 Interatividade Slack: http://localhost:${PORT}/slack/interactivity`);
});