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
const issueStateCache = new Map(); // Cache para armazenar estados anteriores

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

// Processar submissão do formulário e interações
app.post('/slack/interactivity', async (req, res) => {
    try {
        const payload = JSON.parse(req.body.payload);

        // Processar submissão do formulário
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

            // Obter informações do usuário (incluindo handle)
            const userInfo = await slack.users.info({ user: user_id });
            const userName = userInfo.user.real_name || userInfo.user.name;
            const userHandle = `<@${user_id}>`; // Handle clicável no Slack

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
            let fullDescription = `Criada via Slack por ${userName} (${userHandle})\n\n`;
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
                console.log('🆕 NOVA ISSUE CRIADA:', issue.identifier, '- Estado inicial:', issue.state?.name || 'N/A');

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
                                text: `*Em qual página:* ${whichPage}\n*Criado por:* ${userHandle}`
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

                // Construir link da thread do Slack
                const slackTeamInfo = await slack.team.info();
                const threadUrl = `https://${slackTeamInfo.team.domain}.slack.com/archives/${channel_id}/p${message.ts.replace('.', '')}`;

                // Atualizar descrição da issue com link da thread
                const updatedDescription = fullDescription + `\n\n**Thread no Slack:** ${threadUrl}`;
                
                await linear.updateIssue(issue.id, {
                    description: updatedDescription
                });

                console.log('✅ Link da thread adicionado na descrição:', threadUrl);

                // Salvar mapeamento E estado inicial no cache
                issueThreadMap.set(issue.id, {
                    channel: channel_id,
                    ts: message.ts,
                    issueId: issue.id,
                    identifier: issue.identifier,
                    threadUrl: threadUrl,
                    createdBy: user_id, // Salvar ID do usuário que criou
                    createdByHandle: userHandle // Salvar handle para mencionar
                });

                // Salvar estado inicial no cache para detectar mudanças futuras
                const initialState = issue.state?.name || 'Todo';
                issueStateCache.set(issue.id, {
                    name: initialState,
                    timestamp: new Date().toISOString()
                });

                console.log('💾 SALVANDO NO CACHE:');
                console.log(`Issue ID: ${issue.id}`);
                console.log(`Estado inicial: ${initialState}`);
                console.log(`Thread mapeada: Canal ${channel_id}, TS ${message.ts}`);

                console.log(`✅ Landing page request ${issue.identifier} criado com formulário personalizado`);
            }
        }
        // Processar clique no botão "Aprovar"
        else if (payload.type === 'block_actions' && payload.actions?.[0]?.action_id === 'approve_task') {
            console.log('✅ Botão APROVAR clicado');

            // Resposta imediata
            res.status(200).send();

            const action = payload.actions[0];
            const actionData = JSON.parse(action.value);
            const { issueId, identifier } = actionData;
            const user = payload.user;

            console.log(`Aprovando tarefa ${identifier} por ${user.name}`);

            try {
                // Buscar issue para pegar informações do team
                const issueData = await linear.issue(issueId);
                
                // Buscar estados do team para encontrar "Done"
                const team = await linear.team(issueData.team.id);
                const states = await team.states();
                
                const doneState = states.nodes.find(state => 
                    state.name.toLowerCase() === 'done' || 
                    state.name.toLowerCase().includes('done') ||
                    state.name.toLowerCase().includes('completed')
                );

                if (!doneState) {
                    throw new Error('Estado "Done" não encontrado no workflow');
                }

                // Atualizar issue no Linear para Done
                await linear.updateIssue(issueId, {
                    stateId: doneState.id
                });

                // Enviar confirmação na thread
                const threadInfo = issueThreadMap.get(issueId);
                if (threadInfo) {
                    await slack.chat.postMessage({
                        channel: threadInfo.channel,
                        thread_ts: threadInfo.ts,
                        text: `✅ Tarefa ${identifier} aprovada e movida para Done por <@${user.id}>`,
                        blocks: [
                            {
                                type: 'section',
                                text: {
                                    type: 'mrkdwn',
                                    text: `✅ *Tarefa ${identifier} aprovada!*\n*Aprovada por:* <@${user.id}>\n*Status:* Movida para Done`
                                }
                            }
                        ]
                    });
                }

                console.log(`✅ Tarefa ${identifier} aprovada e movida para Done`);

            } catch (error) {
                console.error('❌ Erro ao aprovar tarefa:', error);
                
                // Enviar erro para o usuário
                await slack.chat.postEphemeral({
                    channel: payload.channel.id,
                    user: user.id,
                    text: `❌ Erro ao aprovar tarefa: ${error.message}`
                });
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

// Webhook do Linear - Notificações inteligentes
app.post('/webhook/linear', async (req, res) => {
    try {
        const { type, data, updatedFrom, action } = req.body;

        if (type === 'Issue' && data) {
            const issue = data;
            
            // FILTRAR: Apenas issues do team Landing Pages
            if (issue.team && issue.team.key !== 'LAN') {
                console.log(`🔄 Issue ${issue.identifier} é do team "${issue.team.name}" (${issue.team.key}), ignorando (só processar LAN)`);
                res.status(200).send('OK');
                return;
            }

            console.log(`✅ Issue ${issue.identifier} é do team Landing Pages, processando...`);
            
            const threadInfo = issueThreadMap.get(issue.id);

            // Verificar mudança de estado usando CACHE LOCAL
            if (threadInfo && issue.state) {
                const currentState = issue.state.name;
                let previousState = null;
                let isFirstTime = false;

                // Tentar pegar estado anterior do Linear primeiro
                if (updatedFrom && updatedFrom.state) {
                    previousState = updatedFrom.state.name;
                    console.log('📡 Usando estado anterior do Linear webhook');
                } 
                // Fallback: usar cache local
                else if (issueStateCache.has(issue.id)) {
                    const cachedState = issueStateCache.get(issue.id);
                    previousState = cachedState.name;
                    console.log('💾 Usando estado anterior do cache local');
                } else {
                    // Primeira vez - assumir que veio de "Todo"
                    if (currentState.toLowerCase() !== 'todo') {
                        previousState = 'Todo';
                        isFirstTime = true;
                        console.log('🆕 Primeira detecção - assumindo estado anterior: Todo');
                    }
                }

                if (previousState && (previousState !== currentState || isFirstTime)) {
                    console.log(`Estado anterior: "${previousState}" → Estado atual: "${currentState}"`);

                    // Definir posições dos estados (ordem do workflow)
                    const stateOrder = {
                        'todo': 1,
                        'in progress': 2, 
                        'in review': 3,
                        'done': 4
                    };

                    // Função para obter posição do estado
                    const getStatePosition = (stateName) => {
                        const normalizedState = stateName.toLowerCase().trim();
                        return stateOrder[normalizedState] || 0;
                    };

                    const previousPosition = getStatePosition(previousState);
                    const currentPosition = getStatePosition(currentState);

                    console.log(`Posição anterior: ${previousPosition} → Posição atual: ${currentPosition}`);

                    // REGRAS ESPECÍFICAS: só notificar se ENTRAR em In Progress, In Review ou Done
                    const shouldNotify = (
                        currentPosition > previousPosition && // Movimento para frente
                        currentPosition >= 2 && // Estado atual é In Progress (2), In Review (3) ou Done (4)
                        previousPosition > 0 && currentPosition > 0 // Estados válidos
                    );

                    if (shouldNotify) {
                        let emoji = '🚀';
                        let actionText = 'progrediu';
                        
                        // Emojis específicos para cada estado de destino
                        if (currentState.toLowerCase() === 'in progress') {
                            emoji = '🚀';
                            actionText = 'entrou em desenvolvimento';
                        } else if (currentState.toLowerCase() === 'in review') {
                            emoji = '👀';
                            actionText = 'entrou em revisão';
                        } else if (currentState.toLowerCase() === 'done') {
                            emoji = '✅';
                            actionText = 'foi concluída';
                        }

                        const updateText = `*Status atualizado para:* ${currentState}`;

                        let additionalInfo = '';
                        if (issue.assignee) {
                            additionalInfo += `\n*Assignee:* ${issue.assignee.name}`;
                        }
                        
                        // Para In Progress, mostrar quem atribuiu se houver assignee
                        if (currentState.toLowerCase() === 'in progress' && issue.assignee) {
                            additionalInfo += `\n*Atribuído para desenvolvimento*`;
                        }
                        
                        // Mencionar o usuário que criou a task (sem "Solicitado por")
                        additionalInfo += `\n${threadInfo.createdByHandle}`;

                        // Criar botões específicos para In Review
                        let actionElements = [];
                        if (currentState.toLowerCase() === 'in review') {
                            actionElements.push({
                                type: 'button',
                                text: {
                                    type: 'plain_text',
                                    text: '✅ Aprovar'
                                },
                                value: JSON.stringify({
                                    issueId: issue.id,
                                    action: 'approve',
                                    identifier: issue.identifier
                                }),
                                action_id: 'approve_task',
                                style: 'primary'
                            });
                        }

                        let blocks = [
                            {
                                type: 'section',
                                text: {
                                    type: 'mrkdwn',
                                    text: `${emoji} *Tarefa ${threadInfo.identifier} ${actionText}:*\n${updateText}${additionalInfo}`
                                }
                            },
                            {
                                type: 'context',
                                elements: [
                                    {
                                        type: 'mrkdwn',
                                        text: `<${issue.url}|Ver no Linear> | ${previousState} → ${currentState} | ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
                                    }
                                ]
                            }
                        ];

                        // Adicionar botões se existirem
                        if (actionElements.length > 0) {
                            blocks.push({
                                type: 'actions',
                                elements: actionElements
                            });
                        }

                        await slack.chat.postMessage({
                            channel: threadInfo.channel,
                            thread_ts: threadInfo.ts,
                            text: `${emoji} *Tarefa ${threadInfo.identifier} ${actionText}:*\n${updateText}${additionalInfo}`,
                            blocks: blocks
                        });

                        console.log(`✅ Notificação enviada: "${previousState}" (pos ${previousPosition}) → "${currentState}" (pos ${currentPosition}) - ${actionText}`);
                    } else if (currentPosition < previousPosition) {
                        console.log(`⬅️ Movimento reverso - NÃO notificando: "${previousState}" (pos ${previousPosition}) → "${currentState}" (pos ${currentPosition})`);
                    } else if (currentPosition < 2) {
                        console.log(`ℹ️ Movimento para estado inicial - NÃO notificando: "${currentState}"`);
                    } else {
                        console.log(`ℹ️ Movimento não atende critérios: "${previousState}" → "${currentState}"`);
                    }
                } else if (!previousState) {
                    console.log(`ℹ️ Issue ${issue.identifier} - estado inicial detectado: "${currentState}"`);
                } else {
                    console.log(`ℹ️ Issue ${issue.identifier} - estado não mudou: "${currentState}"`);
                }

                // SEMPRE atualizar cache com estado atual para próxima comparação
                issueStateCache.set(issue.id, {
                    name: currentState,
                    timestamp: new Date().toISOString()
                });
            } 
            // Issue não mapeada
            else if (!threadInfo) {
                console.log(`ℹ️ Issue ${issue.identifier} não está mapeada (não foi criada via Slack)`);
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Erro no webhook:', error);
        res.status(500).send('Erro interno');
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        mappedIssues: issueThreadMap.size,
        cachedStates: issueStateCache.size,
        timestamp: new Date().toISOString()
    });
});

// Debug mappings
app.get('/debug/mappings', (req, res) => {
    const mappings = Array.from(issueThreadMap.entries()).map(([id, info]) => ({
        issueId: id,
        ...info
    }));
    const cache = Array.from(issueStateCache.entries()).map(([id, state]) => ({
        issueId: id,
        ...state
    }));
    res.json({ mappings, cache });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📡 Webhook Linear: http://localhost:${PORT}/webhook/linear`);
    console.log(`⚡ Comando Slack: http://localhost:${PORT}/slack/commands/create-task`);
    console.log(`🔄 Interatividade Slack: http://localhost:${PORT}/slack/interactivity`);
});