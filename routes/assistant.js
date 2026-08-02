const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const pool = require('../db/pool');
const { requirePermission } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { TOOLS, findTool, executeReadOnlyTool, executeWriteTool, describeWriteAction } = require('../db/assistantTools');

const router = express.Router();
router.use(requirePermission('assistant'));

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TOOL_HOPS = 4; // أقصى عدد مرات ننادي فيها الموديل تاني ورا بعض جوه نفس الرسالة (لأدوات القراءة)

async function getApiKey() {
  const r = await pool.query('SELECT anthropic_api_key FROM company_settings WHERE id = 1');
  return r.rows[0] && r.rows[0].anthropic_api_key;
}

function getAnthropicToolSchemas() {
  return TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

function buildSystemPrompt(company) {
  const today = new Date().toISOString().slice(0, 10);
  return `أنت مساعد افتراضي داخل نظام حسابات شركة "${company.name}". عملة الشركة: ${company.currency}. تاريخ اليوم: ${today}.
مهمتك مساعدة المستخدم في الاستعلام عن البيانات المالية والمخزون، وتنفيذ عمليات (مصروفات/استلام فلوس/فواتير شراء/فواتير بيع أو إيجار) لما يطلب منك.
قواعد مهمة:
- لازم تستخدم الأدوات المتاحة لك للحصول على أي بيانات فعلية أو لتنفيذ أي عملية. لا تفترض أرقام من نفسك.
- استخدم أداة واحدة فقط في كل رد (مافيش استدعاء أكتر من أداة في نفس الوقت).
- لو الأداة اللي هتستخدمها بتغيّر بيانات (تسجيل مصروف/استلام/فاتورة شراء/فاتورة بيع)، المستخدم هيشوف ملخص ويأكد بنفسه قبل التنفيذ الفعلي — انت فقط اطلب الأداة بالبيانات الصحيحة والكاملة اللي فهمتها من كلام المستخدم.
- لو معلومة ناقصة لتنفيذ عملية (زي التاريخ أو المبلغ)، اسأل المستخدم عنها الأول قبل ما تستخدم الأداة، ولو التاريخ مش محدد افتراضيًا استخدم تاريخ اليوم.
- ردودك تكون بالعربية، مختصرة، وبلهجة مصرية بسيطة ومهنية.`;
}

router.get('/', asyncHandler(async (req, res) => {
  const apiKey = await getApiKey();
  if (!req.session.assistantHistory) req.session.assistantHistory = [];
  res.render('assistant', {
    title: 'المساعد الافتراضي',
    hasApiKey: !!apiKey,
    history: req.session.assistantHistory,
    pending: req.session.assistantPending || null
  });
}));

router.post('/reset', asyncHandler(async (req, res) => {
  req.session.assistantHistory = [];
  req.session.assistantPending = null;
  res.json({ ok: true });
}));

// بيلف على استدعاءات الموديل: لو طلب أداة قراءة، ينفذها ويرجع النتيجة للموديل تاني ويكرر،
// لو طلب أداة كتابة، يوقف ويرجع طلب تأكيد للمستخدم من غير أي تنفيذ فعلي على قاعدة البيانات
async function runConversationTurn(anthropic, system, history) {
  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: getAnthropicToolSchemas(),
      messages: history
    });

    const textBlocks = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const toolUse = response.content.find(b => b.type === 'tool_use');

    history.push({ role: 'assistant', content: response.content });

    if (!toolUse) {
      return { done: true, reply: textBlocks || 'تم.' };
    }

    const tool = findTool(toolUse.name);
    if (!tool) {
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'أداة غير معروفة', is_error: true }] });
      continue;
    }

    if (tool.readOnly) {
      try {
        const result = await executeReadOnlyTool(tool.name, toolUse.input);
        history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }] });
      } catch (err) {
        history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: String(err.message || err), is_error: true }] });
      }
      continue; // نكمل اللوب عشان نرجع نطلب رد نهائي من الموديل بعد نتيجة القراءة
    }

    // أداة كتابة: نوقف هنا من غير تنفيذ فعلي، ونطلب تأكيد من المستخدم
    return {
      done: false,
      assistantText: textBlocks,
      pending: { toolUseId: toolUse.id, toolName: tool.name, toolInput: toolUse.input },
      confirmText: describeWriteAction(tool.name, toolUse.input)
    };
  }
  return { done: true, reply: 'حصل تكرار كبير في استخدام الأدوات، برجاء إعادة صياغة طلبك.' };
}

router.post('/message', asyncHandler(async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'اكتب رسالة أولاً' });

  const apiKey = await getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'لسه مفيش مفتاح Anthropic API محفوظ. روح لصفحة إعدادات الشركة وضيفه أولاً.' });

  const company = res.locals.company;
  const anthropic = new Anthropic({ apiKey });

  if (!req.session.assistantHistory) req.session.assistantHistory = [];
  if (req.session.assistantPending) {
    return res.status(400).json({ error: 'فيه عملية محتاجة تأكيد أو إلغاء الأول قبل ما تبعت رسالة جديدة.' });
  }

  const history = req.session.assistantHistory;
  // نحد من حجم المحادثة المحفوظة في الجلسة عشان ما تكبرش من غير حدود
  while (history.length > 24) history.shift();
  history.push({ role: 'user', content: message.trim() });

  try {
    const result = await runConversationTurn(anthropic, buildSystemPrompt(company), history);
    req.session.assistantHistory = history;
    if (result.done) {
      return res.json({ reply: result.reply });
    }
    req.session.assistantPending = result.pending;
    return res.json({
      needsConfirmation: true,
      assistantText: result.assistantText,
      confirmText: result.confirmText,
      toolName: result.pending.toolName
    });
  } catch (err) {
    return res.status(500).json({ error: 'حصل خطأ في الاتصال بالمساعد: ' + (err.message || err) });
  }
}));

router.post('/confirm', asyncHandler(async (req, res) => {
  const pending = req.session.assistantPending;
  if (!pending) return res.status(400).json({ error: 'مفيش عملية معلقة للتأكيد' });

  const apiKey = await getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'لسه مفيش مفتاح Anthropic API محفوظ' });

  const company = res.locals.company;
  const { Anthropic } = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey });
  const history = req.session.assistantHistory || [];

  let toolResultContent;
  let isError = false;
  try {
    const result = await executeWriteTool(pending.toolName, pending.toolInput, req.session.user.id);
    toolResultContent = JSON.stringify(result);
  } catch (err) {
    isError = true;
    toolResultContent = String(err.message || err);
  }

  history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: pending.toolUseId, content: toolResultContent, is_error: isError }] });
  req.session.assistantPending = null;

  try {
    const result = await runConversationTurn(anthropic, buildSystemPrompt(company), history);
    req.session.assistantHistory = history;
    if (result.done) {
      return res.json({ reply: result.reply, executed: !isError });
    }
    // نادرًا: الموديل طلب أداة كتابة تانية على طول بعد التأكيد - نوقف تاني لطلب تأكيد جديد
    req.session.assistantPending = result.pending;
    return res.json({
      needsConfirmation: true,
      assistantText: result.assistantText,
      confirmText: result.confirmText,
      toolName: result.pending.toolName,
      executed: !isError
    });
  } catch (err) {
    return res.status(500).json({ error: 'تم التنفيذ لكن حصل خطأ في الرد النهائي من المساعد: ' + (err.message || err) });
  }
}));

router.post('/cancel', asyncHandler(async (req, res) => {
  const pending = req.session.assistantPending;
  if (!pending) return res.status(400).json({ error: 'مفيش عملية معلقة للإلغاء' });

  const apiKey = await getApiKey();
  const company = res.locals.company;
  const history = req.session.assistantHistory || [];
  history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: pending.toolUseId, content: 'تم إلغاء العملية بواسطة المستخدم', is_error: true }] });
  req.session.assistantPending = null;

  if (!apiKey) {
    req.session.assistantHistory = history;
    return res.json({ reply: 'تم الإلغاء.' });
  }

  const { Anthropic } = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey });
  try {
    const result = await runConversationTurn(anthropic, buildSystemPrompt(company), history);
    req.session.assistantHistory = history;
    if (result.done) return res.json({ reply: result.reply });
    req.session.assistantPending = result.pending;
    return res.json({ needsConfirmation: true, assistantText: result.assistantText, confirmText: result.confirmText, toolName: result.pending.toolName });
  } catch (err) {
    return res.json({ reply: 'تم الإلغاء.' });
  }
}));

module.exports = router;
