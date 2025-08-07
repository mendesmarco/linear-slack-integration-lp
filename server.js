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
                    threadUrl: threadUrl
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
        else {
            // Outras interações (botões, etc.)
            res.status(200).send();
        }

    } catch (error) {
        console.error('❌ Erro no processamento de interatividade:', error);
        res.status(200).send();
    }
});

// Webhook do Linear - SUPER DEBUG
app.post('/webhook/linear', async (req, res) => {
    try {
        const { type, data, updatedFrom, action } = req.body;
        console.log('===========================');
        console.log('🎯 WEBHOOK LINEAR RECEBIDO');
        console.log('===========================');

        if (type === 'Issue' && data) {
            const issue = data;
            
            console.log('📋 DADOS DA ISSUE:');
            console.log(`ID: ${issue.id}`);
            console.log(`Identifier: ${issue.identifier}`);
            console.log(`Title: ${issue.title}`);
            console.log(`State: ${issue.state?.name || 'N/A'}`);
            console.log(`Team: ${issue.team?.name} (${issue.team?.key})`);
            
            // FILTRAR: Apenas issues do team Landing Pages
            if (issue.team && issue.team.key !== 'LAN') {
                console.log(`❌ IGNORANDO: Issue é do team "${issue.team.name}" (${issue.team.key}), não LAN`);
                res.status(200).send('OK');
                return;
            }

            console.log('✅ ISSUE É DO TEAM LANDING PAGES - PROCESSANDO...');
            
            const threadInfo = issueThreadMap.get(issue.id);
            
            console.log('🔍 VERIFICAÇÃO DE MAPEAMENTO:');
            console.log(`Issue ${issue.identifier} está mapeada?`, !!threadInfo);
            if (threadInfo) {
                console.log(`Canal: ${threadInfo.channel}, Thread: ${threadInfo.ts}`);
            }

            // DEBUG: Mostrar estado atual do cache antes de processar
            console.log('💾 ESTADO ATUAL DO CACHE:');
            console.log(`Issue ${issue.identifier} no cache:`, issueStateCache.get(issue.id) || 'NÃO EXISTE');
            console.log('Cache completo:', Array.from(issueStateCache.entries()).map(([id, state]) => ({
                id,
                name: state.name,
                timestamp: state.timestamp
            })));
            
            console.log('📡 DADOS DO WEBHOOK:');
            console.log(`Action: ${action}`);
            console.log(`Type: ${type}`);
            console.log(`UpdatedFrom exists: ${!!updatedFrom}`);
            console.log(`UpdatedFrom.state: ${updatedFrom?.state?.name || 'NULL'}`);

            // Verificar mudança de estado usando CACHE LOCAL
            if (threadInfo && issue.state) {
                const currentState = issue.state.name;
                let previousState = null;
                let isFirstTime = false;
                let detectionMethod = '';

                console.log('🔄 DETECTANDO MUDANÇA DE ESTADO:');
                console.log(`Estado atual: "${currentState}"`);

                // Tentar pegar estado anterior do Linear primeiro
                if (updatedFrom && updatedFrom.state) {
                    previousState = updatedFrom.state.name;
                    detectionMethod = '📡 Linear webhook';
                    console.log(`${detectionMethod}: "${previousState}"`);
                } 
                // Fallback: usar cache local
                else if (issueStateCache.has(issue.id)) {
                    const cachedState = issueStateCache.get(issue.id);
                    previousState = cachedState.name;
                    detectionMethod = '💾 Cache local';
                    console.log(`${detectionMethod}: "${previousState}"`);
                } else {
                    // Primeira vez - assumir que veio de "Todo"
                    if (currentState.toLowerCase() !== 'todo') {
                        previousState = 'Todo';
                        isFirstTime = true;
                        detectionMethod = '🆕 Primeira detecção (assumindo Todo)';
                        console.log(`${detectionMethod}: "${previousState}"`);
                    }
                }

                if (previousState && (previousState !== currentState || isFirstTime)) {
                    console.log('📊 COMPARAÇÃO DE ESTADOS:');
                    console.log(`"${previousState}" → "${currentState}"`);

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

                    console.log('⚖️ AVALIAÇÃO DAS REGRAS:');
                    console.log(`Movimento para frente? ${currentPosition > previousPosition}`);
                    console.log(`Estado atual é notificável? ${currentPosition >= 2} (precisa ser >= 2)`);
                    console.log(`Estados válidos? ${previousPosition > 0 && currentPosition > 0}`);
                    console.log(`RESULTADO: ${shouldNotify ? '✅ DEVE NOTIFICAR' : '❌ NÃO DEVE NOTIFICAR'}`);

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

                        console.log('📤 ENVIANDO NOTIFICAÇÃO PARA SLACK:');
                        console.log(`Canal: ${threadInfo.channel}`);
                        console.log(`Thread: ${threadInfo.ts}`);
                        console.log(`Mensagem: ${emoji} ${actionText}`);

                        await slack.chat.postMessage({
                            channel: threadInfo.channel,
                            thread_ts: threadInfo.ts,
                            text: `${emoji} *Tarefa ${threadInfo.identifier} ${actionText}:*\n${updateText}${additionalInfo}`,
                            blocks: [
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
                                            text: `<${issue.url}|Ver no Linear> | ${previousState} → ${currentState} | ${new Date().toLocaleString('pt-BR')}`
                                        }
                                    ]
                                }
                            ]
                        });

                        console.log(`✅ NOTIFICAÇÃO ENVIADA COM SUCESSO!`);
                        console.log(`"${previousState}" (pos ${previousPosition}) → "${currentState}" (pos ${currentPosition}) - ${actionText}`);
                    } else if (currentPosition < previousPosition) {
                        console.log(`⬅️ MOVIMENTO REVERSO - NÃO NOTIFICANDO: "${previousState}" (pos ${previousPosition}) → "${currentState}" (pos ${currentPosition})`);
                    } else if (currentPosition < 2) {
                        console.log(`ℹ️ MOVIMENTO PARA ESTADO INICIAL - NÃO NOTIFICANDO: "${currentState}"`);
                    } else {
                        console.log(`ℹ️ MOVIMENTO NÃO ATENDE CRITÉRIOS: "${previousState}" → "${currentState}"`);
                    }
                } else if (!previousState) {
                    console.log(`ℹ️ ESTADO INICIAL DETECTADO: "${currentState}"`);
                } else {
                    console.log(`ℹ️ ESTADO NÃO MUDOU: "${currentState}"`);
                }

                // SEMPRE atualizar cache com estado atual para próxima comparação
                console.log('💾 ATUALIZANDO CACHE:');
                console.log(`Issue ID: ${issue.id}`);
                console.log(`Novo estado: ${currentState}`);
                issueStateCache.set(issue.id, {
                    name: currentState,
                    timestamp: new Date().toISOString()
                });
                console.log('✅ Cache atualizado');
            } 
            // Casos onde NÃO processa mudança de estado
            else if (!threadInfo) {
                console.log(`ℹ️ Issue ${issue.identifier} NÃO ESTÁ MAPEADA (não foi criada via Slack)`);
            } else if (!issue.state) {
                console.log(`ℹ️ Issue ${issue.identifier} SEM ESTADO DEFINIDO`);
            }
        } else {
            console.log('ℹ️ Webhook não é do tipo Issue ou sem dados');
        }

        console.log('===========================');
        console.log('🏁 PROCESSAMENTO FINALIZADO');
        console.log('===========================');

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ ERRO NO WEBHOOK:', error);
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