export type Expense = { id: string; expense_date: string; amount_minor: number; merchant: string; category: string; status: string }
export type ExpensePage = { items: Expense[]; total: number; page: number; page_size: number }
export type ExpenseTableProps = { refreshKey: number; used: (id: string) => number; onAllocate: (item: Expense) => void; onEdit: (item: Expense) => void; onDelete: (item: Expense) => void; onStatusSaved: () => Promise<void>; deletingId: string | null }
export type ExpenseDraft = { merchant: string; amount: string; date: string; category: string; status: string }
export type ModalKind = 'expense' | 'editExpense' | 'invoice' | 'allocation'
export type Invoice = { id: string; issue_date: string; amount_minor: number; seller: string; seller_tax_number: string | null; buyer_name: string | null; buyer_tax_number: string | null; invoice_number: string | null; source_pdf: string | null }
export type Allocation = { id: string; expense_id: string; invoice_id: string; amount_minor: number }
export type Summary = { expense_total: number; invoice_total: number; allocated_total: number; uncovered_total: number; pending_total: number }
export type InvoiceDraft = { token: string; seller: string; sellerTaxNumber: string; buyerName: string; buyerTaxNumber: string; amount: string; date: string; number: string; filename: string }
export type AgentAttachment = { name: string; content_type: string; size: number; stored_name: string }
export type AgentConversationItem = { id: string; title: string; created_at?: string; updated_at?: string }
export type AIProviderSettings = { configured: boolean; base_url: string; model: string; models: string[]; retention: string }
export type AgentMessage = { id: string; role: 'user' | 'assistant' | 'tool'; content: string; tool_name: string | null; tool_call_id?: string | null; tool_arguments?: Record<string, unknown>; tool_result?: AgentToolEvent['result']; attachments?: AgentAttachment[]; created_at: string }
export type AgentExpensePreview = { expense_date: string | null; amount_minor: number; merchant: string; category: string }
export type PendingAgentAction = { id: string; action_type: string; preview: { action: string; expense?: AgentExpensePreview & { id?: string }; expenses?: AgentExpensePreview[]; invoices?: { id: string; seller: string; issue_date: string; amount_minor: number }[]; amount_minor?: number; requires_confirmation: boolean }; status: string }
export type AgentConversation = AgentConversationItem & { messages: AgentMessage[]; pending_actions: PendingAgentAction[] }
export type AgentQueryItem = Expense & { allocated_minor: number }
export type AgentQueryResult = { items: AgentQueryItem[]; total: number; amount_minor: number; uncovered_minor: number; filters_applied: Record<string, string | number | boolean | null>; display_limit: number; currency: string }
export type AgentToolEvent = { name: string; arguments: Record<string, unknown>; result: AgentQueryResult | Summary | { pending_action: PendingAgentAction }; tool_call_id: string }
export type AgentReply = { content: string; tool_events: AgentToolEvent[]; pending_action: PendingAgentAction | null }

export const categories = ['交通出行', '住宿', '餐饮', '办公用品', '软件订阅', '其他']
// 报销状态：后端存英文代码，页面一律展示中文名称；顺序即修改弹窗下拉框的顺序，tone 对应 .status 的配色
export const expenseStatuses = [
  { code: 'NOT_REQUIRED', label: '无需报销', tone: 'slate' },
  { code: 'NOT_SUBMITTED', label: '未提交', tone: 'amber' },
  { code: 'SUBMITTED', label: '已提交', tone: 'blue' },
  { code: 'PAID', label: '已到账', tone: 'green' },
]
export const findStatus = (code: string) => expenseStatuses.find(item => item.code === code)
export const statusLabel = (code: string) => findStatus(code)?.label ?? `未知状态（${code}）`
export const emptySummary: Summary = { expense_total: 0, invoice_total: 0, allocated_total: 0, uncovered_total: 0, pending_total: 0 }
export const expensePageSize = 10
export const today = () => new Date().toLocaleDateString('en-CA')
export const money = (minor: number) => `¥${(minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`

export function parseMoney(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) <= 0) throw Error('请输入大于 0 的金额，最多两位小数')
  const [yuan, fen = ''] = value.split('.')
  return Number(yuan) * 100 + Number(fen.padEnd(2, '0'))
}

export async function request<T>(path: string, payload?: object, method?: 'PUT' | 'DELETE'): Promise<T> {
  const response = await fetch(`/api/${path}`, payload ? { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : method ? { method } : undefined)
  if (!response.ok) { const error = await response.json().catch(() => null); throw Error(typeof error?.detail === 'string' ? error.detail : `请求失败 (${response.status})`) }
  return response.json()
}

export async function sendAgentMessage<T>(path: string, content: string, files: File[], model: string): Promise<T> {
  const form = new FormData()
  form.append('content', content)
  form.append('model', model)
  files.forEach(file => form.append('files', file))
  const response = await fetch(`/api/${path}`, { method: 'POST', body: form })
  if (!response.ok) { const error = await response.json().catch(() => null); throw Error(typeof error?.detail === 'string' ? error.detail : `请求失败 (${response.status})`) }
  return response.json()
}

export async function loadAvailableInvoices(page: number, pageSize: number, search: string): Promise<{ items: Invoice[]; total: number }> {
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
