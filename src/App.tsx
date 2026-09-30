import { useCallback, useEffect, useRef, useState } from 'react'
import { PromptArea, segmentsToPlainText, type PromptAreaFile, type Segment } from 'prompt-area'
import 'prompt-area/styles.css'
import { ArrowUp, ArrowUpRight, CalendarDays, CirclePlus, Eye, EyeOff, FileCheck2, FileText, LayoutDashboard, MessageCircle, PanelRight, Receipt, Search, Send, Settings2, Trash2, Upload, WalletCards, X } from 'lucide-react'

type Expense = { id: string; expense_date: string; amount_minor: number; merchant: string; category: string; status: string }
type ExpensePage = { items: Expense[]; total: number; page: number; page_size: number }
type ExpenseTableProps = { refreshKey: number; used: (id: string) => number; onAllocate: (item: Expense) => void; onEdit: (item: Expense) => void; onDelete: (item: Expense) => void; deletingId: string | null }
type ExpenseDraft = { merchant: string; amount: string; date: string; category: string; status: string }
type ModalKind = 'expense' | 'editExpense' | 'invoice' | 'allocation'
type Invoice = { id: string; issue_date: string; amount_minor: number; seller: string; seller_tax_number: string | null; buyer_name: string | null; buyer_tax_number: string | null; invoice_number: string | null; source_pdf: string | null }
type Allocation = { id: string; expense_id: string; invoice_id: string; amount_minor: number }
type Summary = { expense_total: number; invoice_total: number; allocated_total: number; uncovered_total: number; pending_total: number }
type InvoiceDraft = { token: string; seller: string; sellerTaxNumber: string; buyerName: string; buyerTaxNumber: string; amount: string; date: string; number: string; filename: string }
type AgentAttachment = { name: string; content_type: string; size: number; stored_name: string }
type AgentConversationItem = { id: string; title: string; created_at?: string; updated_at?: string }
type AIProviderSettings = { configured: boolean; base_url: string; model: string; models: string[]; retention: string }
type AgentMessage = { id: string; role: 'user' | 'assistant' | 'tool'; content: string; tool_name: string | null; tool_call_id?: string | null; tool_arguments?: Record<string, unknown>; tool_result?: AgentToolEvent['result']; attachments?: AgentAttachment[]; created_at: string }
type AgentExpensePreview = { expense_date: string | null; amount_minor: number; merchant: string; category: string }
type PendingAgentAction = { id: string; action_type: string; preview: { action: string; expense?: AgentExpensePreview & { id?: string }; expenses?: AgentExpensePreview[]; invoices?: { id: string; seller: string; issue_date: string; amount_minor: number }[]; amount_minor?: number; requires_confirmation: boolean }; status: string }
type AgentConversation = AgentConversationItem & { messages: AgentMessage[]; pending_actions: PendingAgentAction[] }
type AgentQueryItem = Expense & { allocated_minor: number }
type AgentQueryResult = { items: AgentQueryItem[]; total: number; amount_minor: number; uncovered_minor: number; filters_applied: Record<string, string | number | boolean | null>; display_limit: number; currency: string }
type AgentToolEvent = { name: string; arguments: Record<string, unknown>; result: AgentQueryResult | Summary | { pending_action: PendingAgentAction }; tool_call_id: string }
type AgentReply = { content: string; tool_events: AgentToolEvent[]; pending_action: PendingAgentAction | null }

const categories = ['交通出行', '住宿', '餐饮', '办公用品', '软件订阅', '其他']
// 报销状态：后端存英文代码，页面一律展示中文名称；顺序即修改弹窗下拉框的顺序，tone 对应 .status 的配色
const expenseStatuses = [
  { code: 'NOT_REQUIRED', label: '无需报销', tone: 'slate' },
  { code: 'SUBMITTED', label: '已提交', tone: 'blue' },
  { code: 'PAID', label: '已到账', tone: 'green' },
]
const findStatus = (code: string) => expenseStatuses.find(item => item.code === code)
const statusLabel = (code: string) => findStatus(code)?.label ?? `未知状态（${code}）`
const emptySummary: Summary = { expense_total: 0, invoice_total: 0, allocated_total: 0, uncovered_total: 0, pending_total: 0 }
const expensePageSize = 10
const today = () => new Date().toLocaleDateString('en-CA')
const money = (minor: number) => `¥${(minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
function parseMoney(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) <= 0) throw Error('请输入大于 0 的金额，最多两位小数')
  const [yuan, fen = ''] = value.split('.')
  return Number(yuan) * 100 + Number(fen.padEnd(2, '0'))
}
async function request<T>(path: string, payload?: object, method?: 'PUT' | 'DELETE'): Promise<T> {
  const response = await fetch(`/api/${path}`, payload ? { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : method ? { method } : undefined)
  if (!response.ok) { const error = await response.json().catch(() => null); throw Error(typeof error?.detail === 'string' ? error.detail : `请求失败 (${response.status})`) }
  return response.json()

}
async function sendAgentMessage<T>(path: string, content: string, files: File[], model: string): Promise<T> {
  const form = new FormData()
  form.append('content', content)
  form.append('model', model)
  files.forEach(file => form.append('files', file))
  const response = await fetch(`/api/${path}`, { method: 'POST', body: form })
  if (!response.ok) { const error = await response.json().catch(() => null); throw Error(typeof error?.detail === 'string' ? error.detail : `请求失败 (${response.status})`) }
  return response.json()
}
async function loadAvailableInvoices(page: number, pageSize: number, search: string): Promise<{ items: Invoice[]; total: number }> {
  try {
    return await request<{ items: Invoice[]; total: number }>(`invoices/available?page=${page}&page_size=${pageSize}&search=${encodeURIComponent(search)}`)
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.includes('(404)')) throw cause
    const [all, allocations] = await Promise.all([request<Invoice[]>('invoices'), request<Allocation[]>('allocations')])
    const linked = new Set(allocations.map(item => item.invoice_id))
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const filtered = all.filter(item => !linked.has(item.id) && item.seller.toLocaleLowerCase().includes(normalizedSearch))
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length }
  }
}

function App() {
  const [active, setActive] = useState('仪表盘')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [expenseTotal, setExpenseTotal] = useState(0)
  const [ledgerRefresh, setLedgerRefresh] = useState(0)
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [allocations, setAllocations] = useState<Allocation[]>([])
  const [summary, setSummary] = useState(emptySummary)
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null)
  const [modal, setModal] = useState<ModalKind | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null)
  const [parsing, setParsing] = useState(false)
  const [expenseDraft, setExpenseDraft] = useState<ExpenseDraft>({ merchant: '', amount: '', date: today(), category: categories[0], status: 'SUBMITTED' })
  // 修改用独立草稿，避免覆盖用户尚未提交的“记录支出”表单内容
  const [editDraft, setEditDraft] = useState<ExpenseDraft>({ merchant: '', amount: '', date: today(), category: categories[0], status: 'SUBMITTED' })
  // 正在删除的支出 ID，删除请求返回前不允许再发起删除
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expenseToDelete, setExpenseToDelete] = useState<Expense | null>(null)
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceDraft>({ token: '', seller: '', sellerTaxNumber: '', buyerName: '', buyerTaxNumber: '', amount: '', date: today(), number: '', filename: '' })
  const [invoiceToDelete, setInvoiceToDelete] = useState<Invoice | null>(null)
  const [deletingInvoiceId, setDeletingInvoiceId] = useState<string | null>(null)
  const [allocationDraft, setAllocationDraft] = useState({ expenseId: '', invoiceIds: [] as string[] })

  const [chatOpen, setChatOpen] = useState(false)
  const [chatMounted, setChatMounted] = useState(false)
  const load = useCallback(async (refreshLedger = false) => {
    try {
      const [expenseData, invoiceData, allocationData, summaryData] = await Promise.all([request<ExpensePage>('expenses?page=1&page_size=4'), request<Invoice[]>('invoices'), request<Allocation[]>('allocations'), request<Summary>('summary')])
      setExpenses(expenseData.items); setExpenseTotal(expenseData.total); setInvoices(invoiceData); setAllocations(allocationData); setSummary(summaryData)
      const aiResponse = await fetch('/api/ai/settings')
      setAiConfigured(aiResponse.ok ? (await aiResponse.json()).configured : false)
      setError('')
    } catch { setAiConfigured(false); setError('无法连接后端，请先运行 python -m uvicorn backend.main:app --reload') }
    finally { if (refreshLedger) setLedgerRefresh(value => value + 1) }
  }, [])
  useEffect(() => { void load() }, [load])

  const invoiceUsed = (id: string) => allocations.filter(item => item.invoice_id === id).reduce((sum, item) => sum + item.amount_minor, 0)
  const expenseUsed = (id: string) => allocations.filter(item => item.expense_id === id).reduce((sum, item) => sum + item.amount_minor, 0)
  const openModal = (next: ModalKind) => { setError(''); setModal(next) }
  const openAllocation = (expense: Expense) => { setSelectedExpense(expense); setAllocationDraft({ expenseId: expense.id, invoiceIds: [] }); openModal('allocation') }
  // 库里若有未知状态代码则置空，让下拉框显示“请选择报销状态”并要求重新选择，而不是看似选中了第一项
  const openEdit = (expense: Expense) => { setSelectedExpense(expense); setEditDraft({ merchant: expense.merchant, amount: (expense.amount_minor / 100).toFixed(2), date: expense.expense_date, category: expense.category, status: findStatus(expense.status) ? expense.status : '' }); openModal('editExpense') }
  const expensePayload = (draft: ExpenseDraft) => ({ expense_date: draft.date, amount_minor: parseMoney(draft.amount), merchant: draft.merchant.trim(), category: draft.category })
  const resetInvoice = () => { setInvoiceFile(null); setInvoiceDraft({ token: '', seller: '', sellerTaxNumber: '', buyerName: '', buyerTaxNumber: '', amount: '', date: today(), number: '', filename: '' }) }

  async function parseInvoice() {
    if (!invoiceFile) { setError('请先选择 PDF 或图片发票'); return }
    if (aiConfigured === false) { setError('未配置大模型 API。请先打开“AI 设置”页面填写 API Key 并保存。'); return }
    setParsing(true); setError('')
    try {
      const form = new FormData(); form.append('file', invoiceFile)
      const response = await fetch('/api/invoices/parse', { method: 'POST', body: form })
      if (!response.ok) { const body = await response.json().catch(() => null); throw Error(body?.detail || `发票解析失败 (${response.status})`) }
      const parsed = await response.json()
      setInvoiceDraft({ token: parsed.token, seller: parsed.fields.seller_name || '', sellerTaxNumber: parsed.fields.seller_tax_number || '', buyerName: parsed.fields.buyer_name || '', buyerTaxNumber: parsed.fields.buyer_tax_number || '', amount: parsed.fields.total_amount_minor ? (parsed.fields.total_amount_minor / 100).toFixed(2) : '', date: parsed.fields.issue_date || '', number: parsed.fields.invoice_number || '', filename: parsed.filename })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '发票解析失败') }
    finally { setParsing(false) }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try {
      if (modal === 'expense') await request('expenses', expensePayload(expenseDraft))
      if (modal === 'editExpense' && selectedExpense) await request(`expenses/${encodeURIComponent(selectedExpense.id)}`, { ...expensePayload(editDraft), status: editDraft.status }, 'PUT')
      if (modal === 'invoice') await request('invoices/confirm', { issue_date: invoiceDraft.date, amount_minor: parseMoney(invoiceDraft.amount), seller: invoiceDraft.seller.trim(), seller_tax_number: invoiceDraft.sellerTaxNumber.trim() || null, buyer_name: invoiceDraft.buyerName.trim() || null, buyer_tax_number: invoiceDraft.buyerTaxNumber.trim() || null, invoice_number: invoiceDraft.number.trim() || null, source_pdf: invoiceDraft.token })
      if (modal === 'allocation') await request('allocations', { expense_id: allocationDraft.expenseId, invoice_ids: allocationDraft.invoiceIds })
      setModal(null); resetInvoice(); await load(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败') }
    finally { setSaving(false) }
  }

  async function removeExpense() {
    const expense = expenseToDelete
    if (!expense || deletingId) return
    setDeletingId(expense.id); setError('')
    try {
      await request(`expenses/${encodeURIComponent(expense.id)}`, undefined, 'DELETE')
      setExpenseToDelete(null)
      await load(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败') }
    finally { setDeletingId(null) }
  }
  async function removeInvoice() {
    const invoice = invoiceToDelete
    if (!invoice || deletingInvoiceId) return
    setDeletingInvoiceId(invoice.id); setError('')
    try {
      await request(`invoices/${encodeURIComponent(invoice.id)}`, undefined, 'DELETE')
      setInvoiceToDelete(null)
      await load(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '删除发票失败') }
    finally { setDeletingInvoiceId(null) }
  }

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark">P</div><div><strong>PARA</strong><span>PERSONAL AI REIMBURSEMENT</span></div></div><div className="workspace-area"><div className="workspace-switcher"><span className="workspace-dot" />个人工作区</div><div className="workspace-date"><CalendarDays size={14} aria-hidden="true" />{new Date().toLocaleDateString('zh-CN')}</div></div><nav className="nav-list"><p className="nav-label">工作台</p>{[[LayoutDashboard, '仪表盘'], [WalletCards, '支出'], [Receipt, '发票'], [Settings2, 'AI 设置']].map(([Icon, label]) => <button key={label as string} className={`nav-item ${active === label ? 'active' : ''}`} onClick={() => setActive(label as string)}><Icon size={18} /><span>{label as string}</span></button>)}</nav><div className="sidebar-bottom"><div className="ai-card"><div className="ai-orbit">P</div><div><b>多模态解析</b><span>PDF / 图片发票</span></div></div></div></aside>
    <main className="main-content"><header className="topbar"><div className="crumb" aria-label="当前位置"><span>工作台</span><span className="crumb-separator" aria-hidden="true">/</span><strong>{active}</strong></div><button type="button" className="chat-trigger" aria-label="Agent 对话" aria-expanded={chatOpen} aria-controls="agent-drawer" onClick={() => { setChatMounted(true); setChatOpen(true) }}><span className="chat-trigger-face" aria-hidden="true">··</span><span>对话</span></button></header><div className="content-wrap">
        <section className="hero-row"><div><p className="eyebrow">PERSONAL AI REIMBURSEMENT ASSISTANT</p><h1>每一笔支出，都清楚在账。</h1><p className="hero-copy">上传 PDF 或图片发票，让多模态大模型提取信息。</p></div><div className="hero-actions"><button className="secondary-btn" onClick={() => openModal('invoice')}><Receipt size={17} />添加发票</button><button className="primary-btn" onClick={() => openModal('expense')}><CirclePlus size={17} />记录支出</button></div></section>
        {aiConfigured === false && <p role="alert" className="error-banner">尚未配置大模型 API，无法解析发票。请打开“AI 设置”页面填写 API Key 并保存。</p>}
        {error && <p role="alert" className="error-banner">{error}</p>}
        <section className="metric-grid"><Metric label="支出总额" value={summary.expense_total} icon={<WalletCards size={17} />} detail={`${expenseTotal} 笔支出`} /><Metric label="发票总额" value={summary.invoice_total} icon={<Receipt size={17} />} detail={`${invoices.length} 张发票`} /><Metric label="无发票金额" value={summary.uncovered_total} icon={<FileText size={17} />} detail="按支出逐笔计算" /><Metric label="已提交" value={summary.pending_total} icon={<FileCheck2 size={17} />} detail="尚未到账的已提交支出" /></section>
        {active === 'AI 设置' ? <AISettings onSaved={setAiConfigured} /> : active === '发票' ? <InvoiceList refreshKey={ledgerRefresh} onAdd={() => openModal('invoice')} onDelete={setInvoiceToDelete} deletingId={deletingInvoiceId} /> : <>
          {active !== '支出' && <Dashboard expenses={expenses} summary={summary} />}
          {/* 仪表盘与支出页共用同一位置的台账组件，切换两者时不会重新挂载，分页与搜索状态得以保留 */}
          <ExpenseTable refreshKey={ledgerRefresh} used={expenseUsed} onAllocate={openAllocation} onEdit={openEdit} onDelete={setExpenseToDelete} deletingId={deletingId} />
        </>}
      <footer>PARA <span>·</span> Personal AI Reimbursement Assistant <span>·</span> 本地账本</footer>
    </div></main>
    {chatMounted && <div id="agent-drawer" className="agent-drawer" role="dialog" aria-label="Agent 对话" aria-hidden={!chatOpen} hidden={!chatOpen}><AgentChat open={chatOpen} onLedgerChange={() => load(true)} onClose={() => setChatOpen(false)} /></div>}
    {modal && <Modal modal={modal} saving={saving} error={error} expenseDraft={modal === 'editExpense' ? editDraft : expenseDraft} setExpenseDraft={modal === 'editExpense' ? setEditDraft : setExpenseDraft} invoiceDraft={invoiceDraft} setInvoiceDraft={setInvoiceDraft} invoiceFile={invoiceFile} setInvoiceFile={setInvoiceFile} parsing={parsing} parseInvoice={parseInvoice} allocationDraft={allocationDraft} setAllocationDraft={setAllocationDraft} selectedExpense={selectedExpense} invoices={invoices} expenseUsed={expenseUsed} invoiceUsed={invoiceUsed} allocations={allocations} onSubmit={submit} onClose={() => { setModal(null); resetInvoice() }} />}
    {expenseToDelete && <DeleteExpenseDialog expense={expenseToDelete} linked={expenseUsed(expenseToDelete.id)} deleting={!!deletingId} onCancel={() => setExpenseToDelete(null)} onConfirm={removeExpense} />}
    {invoiceToDelete && <DeleteInvoiceDialog invoice={invoiceToDelete} linked={invoiceUsed(invoiceToDelete.id) > 0} deleting={!!deletingInvoiceId} onCancel={() => setInvoiceToDelete(null)} onConfirm={removeInvoice} />}
  </div>
}

function AgentChat({ open, onLedgerChange, onClose }: { open: boolean; onLedgerChange: () => Promise<void>; onClose: () => void }) {
  const [history, setHistory] = useState<AgentConversationItem[]>([])
  const [conversation, setConversation] = useState<AgentConversation | null>(null)
  const [title, setTitle] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [segments, setSegments] = useState<Segment[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [missingDates, setMissingDates] = useState<Record<string, Record<string, string>>>({})
  const [provider, setProvider] = useState<AIProviderSettings | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const selectedId = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const sequence = useRef(0)

  const select = useCallback(async (id: string) => {
    selectedId.current = id
    const current = ++sequence.current
    setConversation(null); setError(''); setLoading(true)
    try {
      const detail = await request<AgentConversation>(`agent/conversations/${encodeURIComponent(id)}`)
      if (current === sequence.current) setConversation(detail)
    } catch (cause) { if (current === sequence.current) setError(cause instanceof Error ? cause.message : '加载对话失败') }
    finally { if (current === sequence.current) setLoading(false) }
  }, [])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void request<AIProviderSettings>('ai/settings').then(value => {
      if (cancelled) return
      setProvider(value)
      setSelectedModel(current => current && (value.models?.length ? value.models.includes(current) : current === value.model) ? current : value.model)
    }).catch(() => { if (!cancelled) setError('无法读取可用模型') })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    let cancelled = false
    void request<AgentConversationItem[]>('agent/conversations').then(items => {
      if (cancelled) return
      setHistory(items)
      if (items.length) void select(items[0].id)
      else setLoading(false)
    }).catch(cause => { if (!cancelled) { setError(cause instanceof Error ? cause.message : '加载对话列表失败'); setLoading(false) } })
    return () => { cancelled = true; sequence.current++ }
  }, [select])


  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { const created = await request<AgentConversation>('agent/conversations', { title: title.trim() || '新对话' }); setHistory(items => [created, ...items]); setTitle(''); await select(created.id) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '创建对话失败') } finally { setBusy(false) }
  }

  async function removeConversation(item: AgentConversationItem) {
    if (busy || actionBusy || !window.confirm(`确定删除对话“${item.title}”吗？对话记录和附件都会删除。`)) return
    setBusy(true); setError('')
    try {
      await request(`agent/conversations/${encodeURIComponent(item.id)}`, undefined, 'DELETE')
      const remaining = history.filter(current => current.id !== item.id)
      setHistory(remaining)
      if (selectedId.current === item.id) {
        selectedId.current = null
        setConversation(null)
        if (remaining.length) await select(remaining[0].id)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '删除对话失败') } finally { setBusy(false) }
  }


  async function send(event: React.FormEvent) {
    event.preventDefault()
    const content = segmentsToPlainText(segments).trim(); const id = selectedId.current
    if ((!content && !files.length) || !id || busy || actionBusy) return
    const pendingMessage: AgentMessage = {
      id: `pending-${Date.now()}`,
      role: 'user',
      content,
      tool_name: null,
      attachments: files.map((file, index) => ({ name: file.name, content_type: file.type, size: file.size, stored_name: `pending:${index}` })),
      created_at: new Date().toISOString(),
    }
    setConversation(current => current ? { ...current, messages: [...current.messages, pendingMessage] } : current)
    setSegments([]); setFiles([]); setBusy(true); setError('')
    try {
      await sendAgentMessage<AgentReply>(`agent/conversations/${encodeURIComponent(id)}/messages`, content, files, selectedModel)
      const detail = await request<AgentConversation>(`agent/conversations/${encodeURIComponent(id)}`)
      if (selectedId.current === id) setConversation(detail)
      setHistory(await request<AgentConversationItem[]>('agent/conversations'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发送失败')
      try {
        const detail = await request<AgentConversation>(`agent/conversations/${encodeURIComponent(id)}`)
        if (selectedId.current === id) setConversation(detail)
      } catch { /* Keep the visible pending message when refresh is unavailable. */ }
    } finally { setBusy(false) }
  }

  useEffect(() => {
    const container = messagesRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [conversation?.messages.length, busy])


  async function resolve(action: PendingAgentAction, choice: 'confirm' | 'cancel') {
    const id = selectedId.current
    if (!id || busy || actionBusy) return
    setActionBusy(action.id); setError('')
    try {
      await request(`agent/actions/${encodeURIComponent(action.id)}/${choice}`, choice === 'confirm' && action.preview.expenses ? missingDates[action.id] || {} : {})
      const detail = await request<AgentConversation>(`agent/conversations/${encodeURIComponent(id)}`)
      if (selectedId.current === id) setConversation(detail)
      if (choice === 'confirm') await onLedgerChange()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') }
    finally { setActionBusy(null) }
  }
  function addFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files || [])
    setFiles(current => [...current, ...selected].slice(0, 5))
    event.currentTarget.value = ''
  }
  function addPastedImage(file: File) {
    setFiles(current => [...current, file].slice(0, 5))
  }


  function promptFiles(): PromptAreaFile[] {
    return files.map((file, index) => ({ id: `${file.name}-${index}`, name: file.name, size: file.size, type: file.type }))
  }

  function removePromptFile(item: PromptAreaFile) {
    setFiles(current => current.filter((file, index) => `${file.name}-${index}` !== item.id))
  }


  return <section className="agent-page"><div className="agent-drawer-header"><span className="agent-drawer-title">Agent 对话</span><div className="agent-drawer-actions"><button type="button" className="agent-header-button" aria-label="对话记录" aria-expanded={showHistory} onClick={() => setShowHistory(value => !value)}><PanelRight size={20} /></button><button type="button" className="agent-header-button" aria-label="关闭对话" onClick={onClose}><X size={20} /></button></div></div><div className="agent-page-heading"><div><p className="eyebrow">YOUR LEDGER, IN CONVERSATION</p><h1>Hi ~<br />我是 PARA Agent</h1><p>遇到问题，想了解什么，直接告诉我就好。</p></div><span className="agent-heading-mark"><MessageCircle size={27} /></span></div>
    <div className={`agent-layout ${showHistory ? 'history-open' : ''}`}><aside className="agent-history"><div className="agent-section-title"><strong>对话记录</strong><span>{history.length}</span></div><form className="agent-new" onSubmit={create}><input aria-label="新对话标题" placeholder="为新对话命名（可选）" value={title} onChange={event => setTitle(event.target.value)} maxLength={100} /><button className="primary-btn" type="submit" disabled={busy || !!actionBusy}><CirclePlus size={16} />新建对话</button></form><div className="agent-history-list">{history.map(item => <div className={`agent-history-row ${selectedId.current === item.id ? 'selected' : ''}`} key={item.id}><button type="button" className="agent-history-item" onClick={() => { if (!busy && !actionBusy) { void select(item.id); setShowHistory(false) } }} disabled={busy || !!actionBusy}><MessageCircle size={15} /><span>{item.title}</span></button><button type="button" className="agent-delete-button" aria-label={`删除对话 ${item.title}`} title="删除对话" onClick={() => void removeConversation(item)} disabled={busy || !!actionBusy}><Trash2 size={15} /></button></div>)}{!history.length && !loading && <p className="agent-hint">还没有对话。新建一个开始吧。</p>}</div></aside>
    <label className="agent-model-switch">对话模型<select aria-label="对话模型" value={selectedModel} onChange={event => setSelectedModel(event.target.value)} disabled={!provider?.configured || busy || !!actionBusy}>{!provider && <option key="loading-model" value="">正在加载模型…</option>}{provider && (provider.models?.length ? provider.models : provider.model ? [provider.model] : []).map(model => <option key={model} value={model}>{model}</option>)}</select></label>
    <div className="agent-thread"><div className="agent-thread-header"><div><span className="eyebrow">CONVERSATION</span><h2>{conversation?.title || '选择一个对话'}</h2></div><span className="agent-thread-status">{loading ? '正在加载…' : busy ? <><span className="agent-status-dot" /> PARA AGENT 正在处理…</> : '本地账本'}</span></div><div ref={messagesRef} className="agent-messages" aria-live="polite">{loading && <p className="agent-hint">正在加载对话…</p>}{!loading && !conversation && <div className="agent-welcome"><MessageCircle size={30} /><h3>从一个问题开始</h3><p>选择历史对话，或新建对话后查询支出和发票覆盖情况。</p></div>}{conversation && !conversation.messages.length && <div className="agent-welcome"><MessageCircle size={30} /><h3>账本，随问随答</h3><p>试试“这个月有哪些未关联发票的支出？”</p></div>}
      {conversation?.messages.map(message => message.role === 'tool' ? <div key={message.id} className="agent-message assistant">{message.tool_result && message.tool_name && <AgentToolResult tool={{ name: message.tool_name, arguments: message.tool_arguments || {}, result: message.tool_result, tool_call_id: message.tool_call_id || message.id }} />}</div> : <article key={message.id} className={`agent-message ${message.role}`}><div className="agent-message-label">{message.role === 'user' ? '你' : 'PARA AGENT'}</div>{message.attachments?.length ? <div className="agent-attachments">{message.attachments.map(file => <a key={file.stored_name} href={`/api/agent/attachments/${encodeURIComponent(file.stored_name)}`}><FileText size={14} />{file.name}</a>)}</div> : null}{message.content && <div className="agent-message-content">{message.content}</div>}</article>)}
      {busy && <div className="agent-message assistant agent-thinking"><div className="agent-message-label">PARA AGENT</div><div className="agent-message-content"><span className="agent-status-dot" />正在分析你的消息并查询账本…</div></div>}
      {conversation?.pending_actions.map(action => <div className="agent-action" key={action.id}><span className="eyebrow">AWAITING YOUR APPROVAL</span><h3>待确认操作 · {action.preview.action === 'create_expense' ? '新增支出' : action.preview.action === 'import_expenses' ? `批量新增 ${action.preview.expenses?.length || 0} 笔支出` : '关联发票'}</h3>{action.preview.expense && <div className="agent-action-details"><span>商户 <b>{action.preview.expense.merchant}</b></span><span>金额 <b>{money(action.preview.expense.amount_minor)}</b></span><span>日期 <b>{action.preview.expense.expense_date}</b></span>{action.preview.expense.category && <span>类别 <b>{action.preview.expense.category}</b></span>}</div>}{action.preview.expenses && <div className="agent-results">{action.preview.expenses.map((expense, index) => <div key={`${expense.merchant}-${index}`}><strong>{expense.merchant}<small>{expense.expense_date || <label>缺少日期 <input type="date" aria-label={`${expense.merchant} 第 ${index + 1} 笔日期`} value={missingDates[action.id]?.[index] || ''} onChange={event => setMissingDates(current => ({ ...current, [action.id]: { ...current[action.id], [index]: event.target.value } }))} /></label>} · {expense.category}</small></strong><span>{money(expense.amount_minor)}</span></div>)}<div><strong>批量总金额</strong><span>{money(action.preview.amount_minor || 0)}</span></div></div>}{action.preview.invoices && <div className="agent-results">{action.preview.invoices.map(invoice => <div key={invoice.id}><strong>{invoice.seller}<small>{invoice.issue_date} · {invoice.id}</small></strong><span>{money(invoice.amount_minor)}</span></div>)}<div><strong>关联总金额</strong><span>{money(action.preview.amount_minor || 0)}</span></div></div>}<p>确认前不会写入账本；缺失日期需填写后才可确认。</p><div className="agent-action-buttons"><button type="button" className="primary-btn" disabled={!!actionBusy || busy || !!action.preview.expenses?.some((expense, index) => !expense.expense_date && !missingDates[action.id]?.[index])} onClick={() => void resolve(action, 'confirm')}>{actionBusy === action.id ? '处理中…' : '确认执行'}</button><button type="button" className="secondary-btn" disabled={!!actionBusy || busy} onClick={() => void resolve(action, 'cancel')}>取消操作</button></div></div>)}
    </div>{error && <p role="alert" className="error-banner agent-error">{error}</p>}<form className="agent-composer" onSubmit={send}><label htmlFor="agent-draft">发送消息</label><div className="agent-composer-box">{files.length > 0 && <div className="agent-file-list" aria-label="已选择文件">{files.map((file, index) => <span key={`${file.name}-${index}`}><FileText size={14} />{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles(current => current.filter((_, currentIndex) => currentIndex !== index))}><X size={13} /></button></span>)}</div>}<PromptArea value={segments} onChange={setSegments} placeholder="输入消息，按 Enter 发送；Shift + Enter 换行" aria-label="发送消息" data-test-id="agent-draft" minHeight={96} maxLength={4000} disabled={!conversation || busy || !!actionBusy} files={promptFiles()} onFileRemove={removePromptFile} onImagePaste={addPastedImage} onSubmit={() => { const form = document.querySelector<HTMLFormElement>('.agent-composer'); form?.requestSubmit() }} /><div className="agent-composer-toolbar"><div className="agent-composer-left"><input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp,.pdf,.txt,.md,.json,.csv" hidden onChange={addFiles} /><button type="button" className="agent-icon-button" aria-label="上传文件" onClick={() => fileInput.current?.click()} disabled={!conversation || busy || !!actionBusy}><Upload size={20} /></button></div><button className="agent-send-button" type="submit" aria-label="发送" disabled={!conversation || (!segmentsToPlainText(segments).trim() && !files.length) || busy || !!actionBusy}><ArrowUp size={20} /></button></div></div></form></div></div>
  </section>
}

function AgentToolResult({ tool }: { tool: AgentToolEvent }) {
  if (tool.name !== 'query_expenses' && tool.name !== 'get_summary') return null
  if (tool.name === 'get_summary') {
    const result = tool.result as Summary
    return <div className="agent-tool"><span className="eyebrow">LEDGER SUMMARY</span><h4>账本汇总</h4><div className="agent-tool-stats"><span>支出 <b>{money(result.expense_total)}</b></span><span>发票 <b>{money(result.invoice_total)}</b></span><span>已关联 <b>{money(result.allocated_total)}</b></span><span>无发票 <b>{money(result.uncovered_total)}</b></span><span>已提交 <b>{money(result.pending_total)}</b></span></div></div>
  }
  const result = tool.result as AgentQueryResult
  const names: Record<string, string> = { date_from: '开始日期', date_to: '结束日期', category: '类别', merchant: '商户', status: '状态', has_invoice: '有发票', limit: '显示上限' }
  return <div className="agent-tool"><span className="eyebrow">QUERY EXPENSES</span><h4>支出查询 · {result.total} 笔</h4><div className="agent-filters">{Object.entries(result.filters_applied).filter(([, value]) => value !== null && value !== '').map(([key, value]) => <span key={key}>{names[key] || key}：{typeof value === 'boolean' ? value ? '是' : '否' : key === 'status' ? statusLabel(String(value)) : String(value)}</span>)}</div><div className="agent-tool-stats"><span>总金额 <b>{money(result.amount_minor)}</b></span><span>无发票 <b>{money(result.uncovered_minor)}</b></span><span>显示 {result.items.length} / {result.total} 笔</span></div>{result.items.length ? <div className="agent-results">{result.items.map(item => <div key={item.id}><strong>{item.merchant}<small>{item.expense_date} · {item.category} · {statusLabel(item.status)}</small></strong><span>{money(item.amount_minor)}<small>已关联 {money(item.allocated_minor)}</small></span></div>)}</div> : <p className="agent-hint">没有符合条件的支出。</p>}</div>
}

function Dashboard({ expenses, summary }: { expenses: Expense[]; summary: Summary }) { const coverage = summary.expense_total ? Math.min(100, summary.allocated_total / summary.expense_total * 100) : 0; return <section className="dashboard-grid"><div className="panel trend-panel"><div className="panel-heading"><div><p className="eyebrow">OVERVIEW</p><h2>最新支出</h2></div></div>{expenses.length ? <div className="overview-list">{expenses.map(item => <div className="overview-row" key={item.id}><span>{item.merchant}<small>{item.expense_date} · {item.category}</small></span><b>{money(item.amount_minor)}</b></div>)}</div> : <div className="empty-state">暂无支出记录。</div>}</div><div className="panel invoice-panel"><div className="panel-heading"><div><p className="eyebrow">RECEIPTS</p><h2>发票覆盖率</h2></div></div><div className="donut-area"><div className="donut" style={{ background: `conic-gradient(#4d8e7a 0 ${coverage * 3.6}deg, #e7eeea ${coverage * 3.6}deg)` }}><div><strong>{coverage.toFixed(1)}%</strong><span>已覆盖</span></div></div><div className="legend"><Legend color="green" label="已关联发票" value={money(summary.allocated_total)} /><Legend color="light" label="无发票金额" value={money(summary.uncovered_total)} /></div></div></div></section> }
function Metric({ label, value, icon, detail }: { label: string; value: number; icon: React.ReactNode; detail: string }) { return <div className="metric-card"><div className="metric-top"><span className="metric-icon">{icon}</span></div><span className="metric-label">{label}</span><strong className="metric-amount">{money(value)}</strong><span className="metric-change">{detail}</span></div> }
function Legend({ color, label, value }: { color: string; label: string; value: string }) { return <div className="legend-row"><i className={color} /><span>{label}</span><b>{value}</b></div> }
function ExpenseTable({ refreshKey, used, onAllocate, onEdit, onDelete, deletingId }: ExpenseTableProps) {
  // 分页、搜索与加载状态收敛在台账组件内部：翻页只重新渲染这张表，不牵动整个页面
  const [result, setResult] = useState<ExpensePage>({ items: [], total: 0, page: 1, page_size: expensePageSize })
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      setLoading(true)
      request<ExpensePage>(`expenses?page=${page}&page_size=${expensePageSize}&search=${encodeURIComponent(query)}`)
        .then(next => {
          if (cancelled) return
          const lastPage = Math.max(1, Math.ceil(next.total / expensePageSize))
          if (page > lastPage) { setPage(lastPage); return }
          setResult(next); setError('')
        })
        .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '支出台账加载失败') })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, query ? 250 : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [page, query, refreshKey])

  const updateQuery = (value: string) => { setQuery(value); setPage(1); setLoading(true) }
  const changePage = (value: number) => { setPage(value); setLoading(true) }
  const pages = Math.max(1, Math.ceil(result.total / expensePageSize))
  // 重新加载期间保留当前行（配合 is-loading 淡化），避免表格塌成一行“加载中”导致页面高度骤变、看起来像整页刷新
  const rows: Expense[] = error ? [] : result.items
  const placeholder = rows.length ? '' : loading ? '加载中…' : error ? `支出台账加载失败：${error}` : query ? '没有符合条件的支出记录。' : '暂无支出记录。'
  return <section className="panel table-panel"><div className="panel-heading table-heading"><div><p className="eyebrow">EXPENSES</p><h2>支出台账</h2></div><div className="search-box"><Search size={16} /><input aria-label="搜索支出" placeholder="搜索商户、类别或报销状态" value={query} onChange={event => updateQuery(event.target.value)} /></div></div><div className={`table-scroll ${loading ? 'is-loading' : ''}`} aria-busy={loading}><table><thead><tr><th>日期</th><th>商户</th><th>类别</th><th>金额</th><th>无发票金额</th><th>报销状态</th><th>操作</th></tr></thead><tbody>{rows.map(item => <tr key={item.id}><td className="date-cell">{item.expense_date}</td><td><div className="merchant-cell"><div className="merchant-icon green"><Receipt size={16} /></div><strong>{item.merchant}</strong></div></td><td><span className="category-pill">{item.category}</span></td><td className="amount-cell">{money(item.amount_minor)}</td><td className={item.amount_minor > used(item.id) ? 'invoice-no' : 'invoice-yes'}>{money(item.amount_minor - used(item.id))}</td><td><span className={`status ${findStatus(item.status)?.tone ?? 'slate'}`}>{statusLabel(item.status)}</span></td><td><div className="table-actions"><button type="button" className="table-action" aria-label={`修改 ${item.merchant}`} onClick={() => onEdit(item)}>修改</button><button className="table-action" disabled={used(item.id) >= item.amount_minor} onClick={() => onAllocate(item)}>关联发票</button><button type="button" className="table-action danger" aria-label={`${deletingId === item.id ? '正在删除' : '删除'} ${item.merchant}`} disabled={deletingId !== null} onClick={() => onDelete(item)}>{deletingId === item.id ? '删除中…' : '删除'}</button></div></td></tr>)}</tbody></table>{placeholder && <div className="empty-state" role={!loading && error ? 'alert' : undefined}>{placeholder}</div>}</div><div className="expense-pagination"><span>共 {result.total} 笔 · 第 {page} / {pages} 页</span><div><button type="button" disabled={!!error || page <= 1} onClick={() => changePage(page - 1)}>上一页</button><button type="button" disabled={!!error || page >= pages} onClick={() => changePage(page + 1)}>下一页</button></div></div></section>
}
function InvoiceList({ refreshKey, onAdd, onDelete, deletingId }: { refreshKey: number; onAdd: () => void; onDelete: (invoice: Invoice) => void; deletingId: string | null }) {
  const [result, setResult] = useState<{ items: Invoice[]; total: number }>({ items: [], total: 0 })
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      setLoading(true)
      request<{ items: Invoice[]; total: number }>(`invoices?page=${page}&page_size=${expensePageSize}&search=${encodeURIComponent(query)}`)
        .then(next => {
          if (cancelled) return
          const lastPage = Math.max(1, Math.ceil(next.total / expensePageSize))
          if (page > lastPage) { setPage(lastPage); return }
          setResult(next); setError('')
        })
        .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '发票台账加载失败') })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, query ? 250 : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [page, query, refreshKey])
  const pages = Math.max(1, Math.ceil(result.total / expensePageSize))
  return <section className="panel table-panel invoice-ledger"><div className="panel-heading table-heading"><div><p className="eyebrow">INVOICES</p><h2>发票台账</h2></div><div className="table-tools"><div className="search-box"><Search size={16} /><input aria-label="搜索发票" placeholder="搜索号码或购销方" value={query} onChange={event => { setQuery(event.target.value); setPage(1); setLoading(true) }} /></div><button className="primary-btn" onClick={onAdd}><CirclePlus size={16} />添加 PDF / 图片</button></div></div><div className={`table-scroll ${loading ? 'is-loading' : ''}`} aria-busy={loading}><table><thead><tr><th>发票号码</th><th>开票日期</th><th>开票金额</th><th>购买方信息</th><th>销售方信息</th><th>操作</th></tr></thead><tbody>{!error && result.items.map(item => <tr key={item.id}><td>{item.invoice_number || '—'}</td><td className="date-cell">{item.issue_date}</td><td className="amount-cell">{money(item.amount_minor)}</td><td><div className="invoice-party"><strong>{item.buyer_name || '—'}</strong><small>税号：{item.buyer_tax_number || '—'}</small></div></td><td><div className="invoice-party"><strong>{item.seller}</strong><small>税号：{item.seller_tax_number || '—'}</small></div></td><td><button type="button" className="table-action danger" aria-label={`删除发票 ${item.invoice_number || item.seller}`} disabled={deletingId !== null} onClick={() => onDelete(item)}>删除</button></td></tr>)}</tbody></table>{(error || !result.items.length) && <div className="empty-state" role={!loading && error ? 'alert' : undefined}>{loading ? '加载中…' : error ? `发票台账加载失败：${error}` : query ? '没有符合条件的发票。' : '暂无发票。'}</div>}</div><div className="expense-pagination"><span>共 {result.total} 张 · 第 {page} / {pages} 页</span><div><button type="button" disabled={loading || !!error || page <= 1} onClick={() => { setPage(page - 1); setLoading(true) }}>上一页</button><button type="button" disabled={loading || !!error || page >= pages} onClick={() => { setPage(page + 1); setLoading(true) }}>下一页</button></div></div></section>
}

function AISettings({ onSaved }: { onSaved: (configured: boolean) => void }) {
  const [data, setData] = useState<AIProviderSettings | null>(null)
  const [form, setForm] = useState({ base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', api_key: '', retention: 'keep' })
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [testing, setTesting] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testPassed, setTestPassed] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const revision = useRef(0)
  useEffect(() => { fetch('/api/ai/settings').then(response => response.json()).then((value: AIProviderSettings) => { setData(value); setModels(value.models || []); setForm(current => ({ ...current, base_url: value.base_url, model: value.model, retention: value.retention })) }).catch(() => setStatus('无法读取 AI 配置')) }, [])
  function updateForm(next: Partial<typeof form>) {
    revision.current++
    if (next.base_url !== undefined || next.api_key !== undefined) setModels([])
    setForm(current => ({ ...current, ...next })); setTestPassed(false); setStatus('')
  }
  async function fetchModels() {
    setFetchingModels(true); setStatus('正在拉取模型…')
    const currentRevision = revision.current
    try {
      const response = await fetch('/api/ai/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_url: form.base_url, api_key: form.api_key || null }) })
      const value = await response.json()
      if (currentRevision !== revision.current) return
      if (!response.ok) { setStatus(value.detail || '拉取模型失败'); return }
      const available: string[] = value.models
      if (data?.configured && form.base_url.trim().replace(/\/+$/, '') === data.base_url && !form.api_key && available.includes(data.model)) {
        const saved = await request<AIProviderSettings>('ai/settings', { base_url: data.base_url, model: data.model, retention: data.retention, models: available }, 'PUT')
        if (currentRevision !== revision.current) return
        setData(saved)
        setModels(saved.models)
        setStatus(`已同步 ${saved.models.length} 个模型，对话中可直接选择`)
      } else {
        setModels(available)
        if (!available.includes(form.model)) updateForm({ model: available[0] })
        setStatus(`已拉取 ${available.length} 个模型；测试连接并保存配置后，对话中即可选择`)
      }
    } catch { if (currentRevision === revision.current) setStatus('拉取或同步模型失败，请检查服务是否可用') } finally { setFetchingModels(false) }
  }
  async function testConnection() {
    setTesting(true); setTestPassed(false); setStatus('测试中…')
    const testedRevision = revision.current
    try {
      const response = await fetch('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const value = await response.json()
      if (testedRevision !== revision.current) return
      if (!response.ok) { setStatus(value.detail || '连接测试失败'); return }
      setTestPassed(true); setStatus('连接测试成功，可以保存')
    } catch { if (testedRevision === revision.current) setStatus('连接测试失败，请检查服务是否可用') } finally { setTesting(false) }
  }
  async function save() {
    if (!testPassed) { setStatus('请先完成连接测试'); return }
    setStatus('保存中…')
    try {
      const response = await fetch('/api/ai/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, api_key: form.api_key || null, models }) })
      const value = await response.json()
      if (!response.ok) { setStatus(value.detail || '保存失败'); return }
      setData(value); setModels(value.models || []); setForm(current => ({ ...current, api_key: '' })); setTestPassed(false); onSaved(value.configured); setStatus('已保存，之后上传发票即可解析')
    } catch { setStatus('保存失败，请检查服务是否可用') }
  }
  return <section className="panel settings-panel"><p className="eyebrow">AI PROVIDER</p><h2>模型服务商</h2><p className="settings-copy">配置一个 API 服务商并拉取可用模型。API Key 只保存在本机数据库中，页面不会回显完整密钥。</p><div className="settings-form"><label>API Base URL<input value={form.base_url} onChange={event => updateForm({ base_url: event.target.value })} placeholder="https://api.openai.com/v1" /></label><label>模型名称<select value={form.model} onChange={event => updateForm({ model: event.target.value })}>{!models.includes(form.model) && <option key={`current-${form.model}`} value={form.model}>{form.model}</option>}{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label><label>API Key<div className="password-field"><input type={showApiKey ? 'text' : 'password'} value={form.api_key} onChange={event => updateForm({ api_key: event.target.value })} placeholder={data?.configured ? '已配置，留空表示不修改' : '请输入 API Key'} /><button type="button" aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowApiKey(value => !value)}>{showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label><label>原件策略<select value={form.retention} onChange={event => updateForm({ retention: event.target.value })}><option value="keep">保留原始 PDF / 图片</option><option value="delete_after_confirmation">用户确认后删除原件</option></select></label></div><div className="settings-actions"><button className="secondary-btn" onClick={testConnection} disabled={testing || fetchingModels}>{testing ? '测试中…' : '测试连接'}</button><button className="secondary-btn" onClick={fetchModels} disabled={testing || fetchingModels}>{fetchingModels ? '拉取中…' : '拉取模型'}</button><button className="primary-btn" onClick={save} disabled={!testPassed || testing || fetchingModels}>保存配置</button>{status && <span className={testPassed ? 'success-status' : ''}>{status}</span>}</div>{data && <p className={data.configured ? 'configured-note' : 'not-configured-note'}>{data.configured ? '当前状态：已配置，可以解析发票' : '当前状态：未配置 API Key'}</p>}</section>
}

function DeleteExpenseDialog({ expense, linked, deleting, onCancel, onConfirm }: { expense: Expense; linked: number; deleting: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !deleting) onCancel() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleting, onCancel])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !deleting) onCancel() }}><section className="modal delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-expense-title" aria-describedby="delete-expense-description"><div className="delete-dialog-icon"><Trash2 size={22} /></div><p className="eyebrow">DELETE EXPENSE</p><h2 id="delete-expense-title">确认删除这笔支出？</h2><p id="delete-expense-description" className="delete-dialog-description">删除后无法恢复，请核对以下记录。</p><div className="delete-dialog-record"><strong>{expense.merchant}</strong><span>{expense.expense_date} <span aria-hidden="true">·</span> {money(expense.amount_minor)}</span></div>{linked > 0 && <p className="delete-dialog-notice">已关联发票 {money(linked)}。删除后发票将解除关联，发票本身保留，可重新关联到其他支出。</p>}<div className="delete-dialog-actions"><button ref={cancelRef} className="secondary-btn" type="button" disabled={deleting} onClick={onCancel}>取消</button><button className="delete-confirm-btn" type="button" disabled={deleting} onClick={onConfirm}>{deleting ? '删除中…' : '确认删除'}</button></div></section></div>
}

function DeleteInvoiceDialog({ invoice, linked, deleting, onCancel, onConfirm }: { invoice: Invoice; linked: boolean; deleting: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !deleting) onCancel() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleting, onCancel])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !deleting) onCancel() }}><section className="modal delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-invoice-title"><div className="delete-dialog-icon"><Trash2 size={22} /></div><p className="eyebrow">DELETE INVOICE</p><h2 id="delete-invoice-title">确认删除这张发票？</h2><p className="delete-dialog-description">删除后无法恢复，请核对以下记录。</p><div className="delete-dialog-record"><strong>{invoice.invoice_number || '未填写发票号码'}</strong><span>{invoice.seller} · {money(invoice.amount_minor)}</span></div>{linked && <p className="delete-dialog-notice">该发票已关联支出，删除后会解除关联。</p>}<div className="modal-foot"><button ref={cancelRef} type="button" className="secondary-btn" disabled={deleting} onClick={onCancel}>取消</button><button type="button" className="delete-confirm-btn" disabled={deleting} onClick={onConfirm}>{deleting ? '删除中…' : '确认删除'}</button></div></section></div>
}

function Modal(props: { modal: ModalKind; saving: boolean; error: string; expenseDraft: ExpenseDraft; setExpenseDraft: (value: ExpenseDraft) => void; invoiceDraft: InvoiceDraft; setInvoiceDraft: (value: InvoiceDraft) => void; invoiceFile: File | null; setInvoiceFile: (value: File | null) => void; parsing: boolean; parseInvoice: () => Promise<void>; allocationDraft: { expenseId: string; invoiceIds: string[] }; setAllocationDraft: (value: { expenseId: string; invoiceIds: string[] }) => void; selectedExpense: Expense | null; invoices: Invoice[]; expenseUsed: (id: string) => number; invoiceUsed: (id: string) => number; allocations: Allocation[]; onSubmit: (event: React.FormEvent) => Promise<void>; onClose: () => void }) {
  const { modal, saving, error, expenseDraft, setExpenseDraft, invoiceDraft, setInvoiceDraft, invoiceFile, setInvoiceFile, parsing, parseInvoice, allocationDraft, setAllocationDraft, selectedExpense, invoices, expenseUsed, onSubmit, onClose } = props
  const selectedInvoices = invoices.filter(item => allocationDraft.invoiceIds.includes(item.id))
  const selectedTotal = selectedInvoices.reduce((sum, item) => sum + item.amount_minor, 0)
  const remainingExpense = selectedExpense ? selectedExpense.amount_minor - expenseUsed(selectedExpense.id) : 0
  const allocatedExpense = selectedExpense ? expenseUsed(selectedExpense.id) : 0
  const isExpenseForm = modal === 'expense' || modal === 'editExpense'
  // 历史记录的类别可能不在预置列表中（例如 Agent 导入），补进选项，避免下拉框显示成第一项、保存时静默改掉类别
  const categoryOptions = categories.includes(expenseDraft.category) ? categories : [expenseDraft.category, ...categories]
  const heading = { expense: '记录一笔支出', editExpense: '修改支出', invoice: '添加 PDF / 图片发票', allocation: '关联发票与支出' }[modal]
  const hint = { expense: '金额以人民币计，记录会保存至本地数据库。', editExpense: allocatedExpense ? `已关联发票 ${money(allocatedExpense)}，修改后的金额不能低于该金额。` : '可手动调整日期、商户、类别、金额和报销状态，修改会保存至本地数据库。', invoice: '文件将发送给已配置的多模态大模型解析。', allocation: '一张发票只能完整关联一次，支出可以关联多张发票。' }[modal]
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><form className={`modal ${modal === 'allocation' ? 'allocation-modal' : ''}`} onSubmit={onSubmit}><div className="modal-head"><div><h2>{heading}</h2><p>{hint}</p></div><button type="button" onClick={onClose}><X size={19} /></button></div><div className="modal-body">{isExpenseForm && <><label>商户名称<input required value={expenseDraft.merchant} onChange={event => setExpenseDraft({ ...expenseDraft, merchant: event.target.value })} /></label><div className="form-row"><label>金额（元）<input required value={expenseDraft.amount} onChange={event => setExpenseDraft({ ...expenseDraft, amount: event.target.value })} /></label><label>日期<input type="date" required value={expenseDraft.date} onChange={event => setExpenseDraft({ ...expenseDraft, date: event.target.value })} /></label></div><label>类别<select value={expenseDraft.category} onChange={event => setExpenseDraft({ ...expenseDraft, category: event.target.value })}>{categoryOptions.map(category => <option key={category}>{category}</option>)}</select></label>{modal === 'editExpense' && <label>报销状态<select required value={expenseDraft.status} onChange={event => setExpenseDraft({ ...expenseDraft, status: event.target.value })}>{!expenseDraft.status && <option value="">请选择报销状态</option>}{expenseStatuses.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>}</>}{modal === 'invoice' && <><label className="pdf-picker">发票文件<input required={!invoiceDraft.token} type="file" accept="application/pdf,image/*" onChange={event => setInvoiceFile(event.target.files?.[0] || null)} /><span>{invoiceFile?.name || '选择 PDF 或图片，最大 20 MB'}</span></label><button type="button" className="secondary-btn parse-button" disabled={!invoiceFile || parsing} onClick={parseInvoice}>{parsing ? '大模型解析中…' : '开始解析'}</button>{invoiceDraft.token && <div className="parsed-preview"><strong>解析完成：{invoiceDraft.filename}</strong><p>请确认或修改识别结果后保存。</p><div className="form-row"><label>购买方名称<input value={invoiceDraft.buyerName} onChange={event => setInvoiceDraft({ ...invoiceDraft, buyerName: event.target.value })} /></label><label>购买方税号<input value={invoiceDraft.buyerTaxNumber} onChange={event => setInvoiceDraft({ ...invoiceDraft, buyerTaxNumber: event.target.value })} /></label></div><div className="form-row"><label>销售方名称<input required value={invoiceDraft.seller} onChange={event => setInvoiceDraft({ ...invoiceDraft, seller: event.target.value })} /></label><label>销售方税号<input value={invoiceDraft.sellerTaxNumber} onChange={event => setInvoiceDraft({ ...invoiceDraft, sellerTaxNumber: event.target.value })} /></label></div><div className="form-row"><label>金额（元）<input required value={invoiceDraft.amount} onChange={event => setInvoiceDraft({ ...invoiceDraft, amount: event.target.value })} /></label><label>开票日期<input type="date" required value={invoiceDraft.date} onChange={event => setInvoiceDraft({ ...invoiceDraft, date: event.target.value })} /></label></div><label>发票号码<input value={invoiceDraft.number} onChange={event => setInvoiceDraft({ ...invoiceDraft, number: event.target.value })} /></label></div>}</>}{modal === 'allocation' && <><label>支出<select value={allocationDraft.expenseId} disabled><option>{selectedExpense?.merchant} · 剩余 {money(remainingExpense)}</option></select></label><AllocationPicker selected={allocationDraft.invoiceIds} onChange={invoiceIds => setAllocationDraft({ ...allocationDraft, invoiceIds })} /><div className={`allocation-total ${selectedTotal > remainingExpense ? 'over-limit' : ''}`}><span>已选 {allocationDraft.invoiceIds.length} 张发票，总金额</span><strong>{money(selectedTotal)}</strong><small>支出剩余 {money(remainingExpense)}{selectedTotal > remainingExpense ? ' · 已超过支出剩余金额' : ''}</small></div></>}{error && <p role="alert" className="modal-error">{error}</p>}</div><div className="modal-foot"><button type="button" className="secondary-btn" onClick={onClose}>取消</button><button className="primary-btn" disabled={saving || (modal === 'invoice' && !invoiceDraft.token) || (modal === 'allocation' && (allocationDraft.invoiceIds.length === 0 || selectedTotal > remainingExpense))}>{saving ? '保存中…' : '确认并保存'}</button></div></form></div>
}

function AllocationPicker({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<{ items: Invoice[]; total: number }>({ items: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      setLoading(true)
      loadAvailableInvoices(page, 10, search)
        .then(value => { if (!cancelled) { setResult(value); setError('') } })
        .catch(cause => { if (!cancelled) setError(cause instanceof Error && cause.message.includes('(404)') ? '后端尚未加载发票分页接口，请重启后端服务' : `发票列表加载失败：${cause instanceof Error ? cause.message : '请重试'}`) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, search ? 250 : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [page, search])
  const pages = Math.max(1, Math.ceil(result.total / 10))
  return <div className="invoice-table-picker"><div className="invoice-table-tools"><label htmlFor="invoice-search">发票名称搜索</label><div className="search-box"><Search size={16} /><input id="invoice-search" value={search} placeholder="输入销售方名称" onChange={event => { setSearch(event.target.value); setPage(1); setLoading(true) }} /></div></div><div className="invoice-table-scroll"><table><thead><tr><th>选择</th><th>发票名称（销售方）</th><th>开票日期</th><th>发票号码</th><th>金额</th></tr></thead><tbody>{!loading && !error && result.items.map(item => <tr key={item.id}><td><input type="checkbox" aria-label={`选择 ${item.seller} ${item.invoice_number || item.id}`} checked={selected.includes(item.id)} onChange={() => onChange(selected.includes(item.id) ? selected.filter(id => id !== item.id) : [...selected, item.id])} /></td><td>{item.seller}</td><td>{item.issue_date}</td><td>{item.invoice_number || '—'}</td><td>{money(item.amount_minor)}</td></tr>)}{(loading || error || !result.items.length) && <tr><td colSpan={5} className="invoice-table-empty">{loading ? '加载中…' : error || '没有符合条件的可关联发票'}</td></tr>}</tbody></table></div><div className="invoice-pagination"><span>共 {result.total} 张 · 第 {page} / {pages} 页 · 已选 {selected.length} 张（跨页保留）</span><div><button type="button" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>上一页</button><button type="button" disabled={loading || page >= pages} onClick={() => setPage(page + 1)}>下一页</button></div></div></div>
}

export default App
