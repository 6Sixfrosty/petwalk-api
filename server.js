require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js'); // ← ESSENCIAL

const app = express();

// Middlewares Globais
app.use(cors());
app.use(express.json());

// Validação de variáveis de ambiente
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("❌ ERRO FATAL: Credenciais do Supabase ausentes no arquivo .env");
    process.exit(1);
}

// Inicialização do Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==========================================
// 🔐 MÓDULO 1: AUTENTICAÇÃO E USUÁRIOS
// ==========================================

// 1.1 Registro de Usuário (Dono ou Passeador)
app.post('/api/auth/registo', async (req, res) => {
    const { nome, email, senha, tipo_usuario, telefone } = req.body;

    if (tipo_usuario !== 'dono' && tipo_usuario !== 'passeador') {
        return res.status(400).json({ erro: "O tipo de usuário deve ser 'dono' ou 'passeador'." });
    }

    try {
        const { data, error } = await supabase
            .from('usuarios')
            .insert([{ nome, email, senha_hash: senha, tipo_usuario, telefone, online: false }])
            .select();

        if (error) throw error;

        // Se for passeador, cria o perfil com carteira zerada
        if (tipo_usuario === 'passeador' && data[0]) {
            await supabase.from('perfil_passeador').insert([{
                usuario_id: data[0].id,
                biografia: "Adoro animais! Pronto para novos passeios.",
                preco_por_passeio: 35.00,
                carteira_saldo: 0.00,
                nota_media: 5.0
            }]);
        }

        res.status(201).json({ mensagem: "Usuário criado com sucesso!", usuario: data[0] });
    } catch (error) {
        res.status(500).json({ erro: "Erro ao criar conta.", detalhes: error.message });
    }
});

// 1.2 Login — seta online=true automaticamente
app.post('/api/auth/login', async (req, res) => {
    const { email, senha } = req.body;
    console.log("👉 O frontend enviou:", email, senha);

    try {
        const { data, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('email', email)
            .eq('senha_hash', senha)
            .single();

        console.log("👉 Resposta do Supabase:", data, error);

        if (error || !data) {
            return res.status(401).json({ erro: "E-mail ou senha incorretos!" });
        }

        // ✅ Marca o usuário como ONLINE no banco
        await supabase
            .from('usuarios')
            .update({ online: true })
            .eq('id', data.id);

        // Retorna o usuário já com online=true
        res.json({ mensagem: "Login efetuado com sucesso!", usuario: { ...data, online: true } });
    } catch (error) {
        res.status(500).json({ erro: "Erro interno no servidor.", detalhes: error.message });
    }
});

// 1.3 Logout — seta online=false
app.post('/api/auth/logout', async (req, res) => {
    const { usuario_id } = req.body;

    if (!usuario_id) {
        return res.status(400).json({ erro: "usuario_id é obrigatório." });
    }

    try {
        const { error } = await supabase
            .from('usuarios')
            .update({ online: false })
            .eq('id', usuario_id);

        if (error) throw error;

        res.json({ mensagem: "Logout realizado. Usuário marcado como offline." });
    } catch (error) {
        res.status(500).json({ erro: "Erro ao fazer logout.", detalhes: error.message });
    }
});

// ==========================================
// 🐶 MÓDULO 2: PETS E EXPLORAÇÃO
// ==========================================

// 2.1 Cadastrar Novo Pet
app.post('/api/pets', async (req, res) => {
    const { dono_id, nome, raca, porte, observacoes } = req.body;
    try {
        const { data, error } = await supabase
            .from('pets')
            .insert([{ dono_id, nome, raca, porte, observacoes }])
            .select();

        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// 2.2 Buscar Pets de um Dono
app.get('/api/pets/dono/:dono_id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('pets')
            .select('*')
            .eq('dono_id', req.params.dono_id);

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// 2.3 Listar Todos os Passeadores (com filtro opcional de online)
app.get('/api/passeadores', async (req, res) => {
    try {
        let query = supabase
            .from('perfil_passeador')
            .select(`
                *,
                usuarios (id, nome, telefone, online)
            `);

        // ✅ Filtro: ?online=true retorna apenas os que estão logados
        if (req.query.online === 'true') {
            // Filtra via join — passeadores cujo usuário está online
            query = supabase
                .from('perfil_passeador')
                .select(`
                    *,
                    usuarios!inner (id, nome, telefone, online)
                `)
                .eq('usuarios.online', true);
        }

        const { data, error } = await query;
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// 2.4 Passeadores Online (atalho direto para o mapa do Dono)
app.get('/api/passeadores/online', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('perfil_passeador')
            .select(`
                *,
                usuarios!inner (id, nome, telefone, online)
            `)
            .eq('usuarios.online', true);

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// ==========================================
// 📅 MÓDULO 3: PASSEIOS E PAGAMENTOS
// ==========================================

// 3.1 Agendar Passeio (dono escolhe passeador + tipo)
// tipo_passeio: 'agora' | 'agendado'
app.post('/api/passeios', async (req, res) => {
    const { dono_id, passeador_id, pet_id, data_horario, preco_total, tipo_passeio } = req.body;

    // Validação do tipo
    if (tipo_passeio !== 'agora' && tipo_passeio !== 'agendado') {
        return res.status(400).json({ erro: "tipo_passeio deve ser 'agora' ou 'agendado'." });
    }

    try {
        const { data, error } = await supabase
            .from('passeios')
            .insert([{
                dono_id,
                passeador_id,
                pet_id,
                status: 'pendente',
                data_horario,
                preco_total,
                tipo_passeio
            }])
            .select();

        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// 3.2 Buscar Passeios "Agora" pendentes — para passeadores online verem
// Esta é a rota que alimenta o scroll estilo Uber na tela do passeador
app.get('/api/passeios/disponiveis', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('passeios')
            .select(`
                *,
                pets (nome, raca, porte, observacoes),
                usuarios!dono_id (nome, telefone)
            `)
            .eq('status', 'pendente')
            .eq('tipo_passeio', 'agora')
            .order('data_horario', { ascending: true });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// 3.3 Buscar Passeios de um Passeador específico
app.get('/api/passeios/passeador/:passeador_id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('passeios')
            .select(`
                *,
                pets (nome, raca, observacoes),
                usuarios!dono_id (nome)
            `)
            .eq('passeador_id', req.params.passeador_id)
            .eq('status', 'pendente');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// 3.4 Atualizar Status do Passeio & Lógica Financeira
app.put('/api/passeios/:id/status', async (req, res) => {
    const passeio_id = req.params.id;
    const { status_novo } = req.body; // 'aceito', 'em_andamento', 'concluido', 'cancelado'

    try {
        const { data: passeioAtualizado, error } = await supabase
            .from('passeios')
            .update({ status: status_novo })
            .eq('id', passeio_id)
            .select()
            .single();

        if (error) throw error;

        // ✅ Ao concluir: credita 90% do valor na carteira do passeador
        if (status_novo === 'concluido') {
            const passeador_id = passeioAtualizado.passeador_id;
            const valorTotal = parseFloat(passeioAtualizado.preco_total);
            const valorPasseador = valorTotal * 0.90; // 90% para o passeador

            const { data: perfil, error: perfilError } = await supabase
                .from('perfil_passeador')
                .select('carteira_saldo')
                .eq('usuario_id', passeador_id)
                .single();

            if (perfilError) throw perfilError;

            const novoSaldo = parseFloat(perfil.carteira_saldo) + valorPasseador;

            await supabase
                .from('perfil_passeador')
                .update({ carteira_saldo: novoSaldo })
                .eq('usuario_id', passeador_id);

            return res.json({
                mensagem: `Passeio concluído. Passeador recebeu R$ ${valorPasseador.toFixed(2)} (90%).`,
                passeio: passeioAtualizado,
                valor_creditado: valorPasseador
            });
        }

        res.json({ mensagem: `Passeio atualizado para ${status_novo}`, passeio: passeioAtualizado });
    } catch (error) {
        res.status(500).json({ erro: "Erro ao atualizar passeio.", detalhes: error.message });
    }
});

// ==========================================
// 🚀 INICIALIZAÇÃO DO SERVIDOR
// ==========================================

app.get('/', (req, res) => {
    res.json({ status: "online", mensagem: "A API do PetWalk está rodando perfeitamente! 🐶" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🔗 Banco de dados: Conectado ao Supabase`);
});
