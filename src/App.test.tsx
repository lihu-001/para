// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from './App'

type Call = { method: string; path: string }

type BackendOptions = { allocations?: unknown[]; statuses?: Record<string, string>; routes?: Record<string, unknown> }

// 模拟后端：记录每次请求，并可挂起指定页的台账请求，用于观察“加载中”的中间状态；
// 同时支持修改（PUT）与删除（DELETE）支出，结果会体现在之后的台账查询中，也可模拟后端拒绝或挂起这些请求。
// statuses 按 ID 覆盖初始报销状态；routes 为额外的 GET 路由（路径 → 响应体）
function mockBackend(initialTotal = 25, { allocations = [], statuses = {}, routes = {} }: BackendOptions = {}) {
  let total = initialTotal
  const calls: Call[] = []
  const updates: { path: string; body: unknown }[] = []
  const edits = new Map<string, Record<string, unknown>>()
  const deleted = new Set<string>()
  let rejectUpdate = ''
  let rejectDelete = ''
  let deleteGate: Promise<void> | null = null
  let openDeleteGate = () => {}
  const held = new Map<number, () => void>()
  const holding = new Set<number>()
  const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  const expensePage = (page: number, size: number) => {
    // 按编号生成全部记录再剔除已删除的，删除后后续记录会自然前移
    const all = Array.from({ length: total }, (_, index) => `e${index + 1}`).filter(id => !deleted.has(id))
    const items = all.slice((page - 1) * size, page * size).map(id => {
      const n = Number(id.slice(1))
      return { id, expense_date: '2025-01-01', amount_minor: n * 100, merchant: `商户${n}`, category: '餐饮', status: statuses[id] ?? 'SUBMITTED', ...edits.get(id) }
    })
    return { items, total: all.length, page, page_size: size }
  }
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    calls.push({ method, path: url.pathname + url.search })
    if (url.pathname === '/api/expenses' && method === 'POST') { total += 1; return Promise.resolve(reply({ id: 'new' })) }
    if (url.pathname.startsWith('/api/expenses/') && method === 'PUT') {
      const body = JSON.parse(String(init?.body))
      updates.push({ path: url.pathname, body })
      if (rejectUpdate) return Promise.resolve({ ok: false, status: 422, json: async () => ({ detail: rejectUpdate }) })
      edits.set(decodeURIComponent(url.pathname.slice('/api/expenses/'.length)), body)
      return Promise.resolve(reply(body))
    }
    if (url.pathname.startsWith('/api/expenses/') && method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/api/expenses/'.length))
      return (deleteGate ?? Promise.resolve()).then(() => {
        if (rejectDelete) return { ok: false, status: 404, json: async () => ({ detail: rejectDelete }) }
        deleted.add(id)
        return reply({ ok: true, id, released_invoices: 0 })
      })
    }
    if (method === 'GET' && Object.hasOwn(routes, url.pathname)) return Promise.resolve(reply(routes[url.pathname]))
    if (url.pathname === '/api/expenses') {
      const page = Number(url.searchParams.get('page'))
      const body = expensePage(page, Number(url.searchParams.get('page_size')))
      if (holding.has(page)) return new Promise(resolve => held.set(page, () => resolve(reply(body))))
      return Promise.resolve(reply(body))
    }
    if (url.pathname === '/api/invoices') return Promise.resolve(reply([]))
    if (url.pathname === '/api/allocations') return Promise.resolve(reply(allocations))
    if (url.pathname === '/api/summary') return Promise.resolve(reply({ expense_total: 0, invoice_total: 0, allocated_total: 0, uncovered_total: 0, pending_total: 0 }))
    if (url.pathname === '/api/ai/settings') return Promise.resolve(reply({ configured: false }))
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    calls,
    updates,
    hold: (page: number) => holding.add(page),
    release: (page: number) => { holding.delete(page); held.get(page)?.() },
    rejectUpdates: (detail: string) => { rejectUpdate = detail },
    rejectDeletes: (detail: string) => { rejectDelete = detail },
    holdDeletes: () => { deleteGate = new Promise<void>(resolve => { openDeleteGate = () => resolve() }) },
    releaseDeletes: () => { deleteGate = null; openDeleteGate() },
  }
}

const busy = (table: HTMLElement) => table.closest('.table-scroll')?.getAttribute('aria-busy')

// 渲染应用并等待首屏数据（台账第 1 页、AI 配置提示）全部就绪
async function renderApp(options: BackendOptions = {}) {
  const backend = mockBackend(25, options)
  render(<App />)
  const table = await screen.findByRole('table')
  await within(table).findByText('商户1')
  await screen.findByText('尚未配置大模型 API，无法解析发票。请打开“AI 设置”页面填写 API Key 并保存。')
  return { backend, table }
}

async function goToPage2(table: HTMLElement) {
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await within(table).findByText('商户11')
  await waitFor(() => expect(busy(table)).toBe('false'))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('支出台账分页', () => {
  it('翻页只重新请求台账，加载期间保留当前行而不是清空表格', async () => {
    const { backend, table } = await renderApp()
    const before = backend.calls.length
    backend.hold(2)

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(backend.calls.length).toBe(before + 1))

    // 第 2 页尚未返回：旧行仍在，只有台账区域标记为忙碌，不会出现整表“加载中”
    expect(within(table).getByText('商户1')).toBeTruthy()
    expect(screen.queryByText('加载中…')).toBeNull()
    expect(busy(table)).toBe('true')
    expect(screen.getByText('共 25 笔 · 第 2 / 3 页')).toBeTruthy()
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(false)

    backend.release(2)
    await within(table).findByText('商户11')
    await waitFor(() => expect(busy(table)).toBe('false'))
    expect(within(table).queryByText('商户1')).toBeNull()

    // 整个翻页过程只发出这一次台账请求，汇总、发票等其余数据不会重新加载
    expect(backend.calls.slice(before)).toEqual([{ method: 'GET', path: '/api/expenses?page=2&page_size=10&search=' }])
  })

  it('仪表盘切换到支出页时保留当前页，不重新挂载也不重新请求', async () => {
    const { backend, table } = await renderApp()
    await goToPage2(table)
    const before = backend.calls.length

    fireEvent.click(screen.getByRole('button', { name: '支出' }))

    expect(screen.getByRole('table')).toBe(table)
    expect(screen.getByText('共 25 笔 · 第 2 / 3 页')).toBeTruthy()
    expect(backend.calls.length).toBe(before)
  })

  it('新增支出后刷新台账并停留在当前页', async () => {
    const { backend, table } = await renderApp()
    await goToPage2(table)
    const before = backend.calls.length

    fireEvent.click(screen.getByRole('button', { name: '记录支出' }))
    fireEvent.change(screen.getByLabelText('商户名称'), { target: { value: '新商户' } })
    fireEvent.change(screen.getByLabelText('金额（元）'), { target: { value: '12.50' } })
    fireEvent.click(screen.getByRole('button', { name: '确认并保存' }))

    await screen.findByText('共 26 笔 · 第 2 / 3 页')
    await waitFor(() => expect(busy(table)).toBe('false'))
    expect(backend.calls.slice(before)).toContainEqual({ method: 'GET', path: '/api/expenses?page=2&page_size=10&search=' })
  })
})

describe('支出台账修改', () => {
  it('点击修改后预填当前值（含报销状态），保存发送 PUT 并刷新台账', async () => {
    const { backend, table } = await renderApp()

    fireEvent.click(within(table).getByRole('button', { name: '修改 商户3' }))
    const dialog = screen.getByRole('heading', { name: '修改支出' }).closest('form') as HTMLElement
    expect((within(dialog).getByLabelText('商户名称') as HTMLInputElement).value).toBe('商户3')
    expect((within(dialog).getByLabelText('金额（元）') as HTMLInputElement).value).toBe('3.00')
    expect((within(dialog).getByLabelText('日期') as HTMLInputElement).value).toBe('2025-01-01')
    expect((within(dialog).getByLabelText('类别') as HTMLSelectElement).value).toBe('餐饮')
    const status = within(dialog).getByLabelText('报销状态') as HTMLSelectElement
    expect(status.value).toBe('SUBMITTED')
    // 下拉框只展示中文状态名
    expect(Array.from(status.options, option => option.textContent)).toEqual(['无需报销', '已提交', '已到账'])

    fireEvent.change(within(dialog).getByLabelText('商户名称'), { target: { value: ' 改名商户 ' } })
    fireEvent.change(within(dialog).getByLabelText('金额（元）'), { target: { value: '45.6' } })
    fireEvent.change(within(dialog).getByLabelText('日期'), { target: { value: '2025-02-03' } })
    fireEvent.change(within(dialog).getByLabelText('类别'), { target: { value: '住宿' } })
    fireEvent.change(status, { target: { value: 'SUBMITTED' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认并保存' }))

    await within(table).findByText('改名商户')
    expect(within(table).queryByText('商户3')).toBeNull()
    expect(screen.queryByRole('heading', { name: '修改支出' })).toBeNull()
    const row = within(table).getByText('改名商户').closest('tr') as HTMLElement
    expect(within(row).getByText('已提交')).toBeTruthy()
    expect(backend.updates).toEqual([{ path: '/api/expenses/e3', body: { expense_date: '2025-02-03', amount_minor: 4560, merchant: '改名商户', category: '住宿', status: 'SUBMITTED' } }])
  })

  it('已关联发票时提示金额下限，后端拒绝后保留弹窗并显示原因', async () => {
    const { backend, table } = await renderApp({ allocations: [{ id: 'a1', expense_id: 'e2', invoice_id: 'i1', amount_minor: 150 }] })
    backend.rejectUpdates('修改后的金额不能低于已关联发票总额 1.50 元')

    fireEvent.click(within(table).getByRole('button', { name: '修改 商户2' }))
    const dialog = screen.getByRole('heading', { name: '修改支出' }).closest('form') as HTMLElement
    expect(within(dialog).getByText('已关联发票 ¥1.50，修改后的金额不能低于该金额。')).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText('金额（元）'), { target: { value: '1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认并保存' }))

    expect((await within(dialog).findByRole('alert')).textContent).toBe('修改后的金额不能低于已关联发票总额 1.50 元')
    expect(screen.getByRole('heading', { name: '修改支出' })).toBeTruthy()
    expect(within(table).getByText('商户2')).toBeTruthy()
    expect(backend.updates).toHaveLength(1)
  })
})

describe('支出台账删除', () => {
  it('确认后发送 DELETE，删除期间按钮不可用，完成后刷新台账与汇总', async () => {
    const { backend, table } = await renderApp()
    backend.holdDeletes()
    const before = backend.calls.length

    fireEvent.click(within(table).getByRole('button', { name: '删除 商户3' }))

    const dialog = screen.getByRole('dialog', { name: '确认删除这笔支出？' })
    expect(within(dialog).getByText('商户3')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    const pending = within(table).getByRole('button', { name: '正在删除 商户3' }) as HTMLButtonElement
    expect(pending.textContent).toBe('删除中…')
    // 删除请求返回前，所有删除按钮都不可用，避免重复删除
    expect(within(table).getAllByRole('button', { name: /删除 商户/ }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)

    backend.releaseDeletes()
    await screen.findByText('共 24 笔 · 第 1 / 3 页')
    expect(within(table).queryByText('商户3')).toBeNull()
    await waitFor(() => expect((within(table).getByRole('button', { name: '删除 商户4' }) as HTMLButtonElement).disabled).toBe(false))
    const after = backend.calls.slice(before)
    expect(after[0]).toEqual({ method: 'DELETE', path: '/api/expenses/e3' })
    expect(after).toContainEqual({ method: 'GET', path: '/api/summary' })
    expect(after).toContainEqual({ method: 'GET', path: '/api/expenses?page=1&page_size=10&search=' })
  })

  it('取消确认时不发送请求', async () => {
    const { backend, table } = await renderApp()
    const confirm = vi.spyOn(window, 'confirm')
    const before = backend.calls.length

    fireEvent.click(within(table).getByRole('button', { name: '删除 商户3' }))
    const dialog = screen.getByRole('dialog', { name: '确认删除这笔支出？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '确认删除这笔支出？' })).toBeNull()
    expect(confirm).not.toHaveBeenCalled()

    expect(backend.calls.slice(before)).toEqual([])
    expect(within(table).getByText('商户3')).toBeTruthy()
  })

  it('已关联发票的支出，确认框提示会解除关联', async () => {
    const { table } = await renderApp({ allocations: [{ id: 'a1', expense_id: 'e2', invoice_id: 'i1', amount_minor: 150 }] })
    const confirm = vi.spyOn(window, 'confirm')

    fireEvent.click(within(table).getByRole('button', { name: '删除 商户2' }))

    const dialog = screen.getByRole('dialog', { name: '确认删除这笔支出？' })
    expect(within(dialog).getByText(/已关联发票 ¥1.50/)).toBeTruthy()
    expect(within(dialog).getByText(/发票本身保留/)).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('删除失败时显示原因并保留该行', async () => {
    const { backend, table } = await renderApp()
    backend.rejectDeletes('支出不存在')

    fireEvent.click(within(table).getByRole('button', { name: '删除 商户4' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认删除这笔支出？' })).getByRole('button', { name: '确认删除' }))

    expect(await screen.findByText('支出不存在')).toBeTruthy()
    expect(within(table).getByText('商户4')).toBeTruthy()
    expect((within(table).getByRole('button', { name: '删除 商户4' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('报销状态中文展示', () => {
  it('台账中各报销状态都显示中文名，不出现英文代码', async () => {
    const statuses = { e1: 'NOT_REQUIRED', e2: 'SUBMITTED', e3: 'PAID' }
    const { table } = await renderApp({ statuses })
    const label = (merchant: string) => within(table).getByText(merchant).closest('tr')?.querySelector('.status')?.textContent
    expect(['商户1', '商户2', '商户3', '商户4'].map(label)).toEqual(['无需报销', '已提交', '已到账', '已提交'])
    expect(table.textContent).not.toMatch(/NOT_REQUIRED|SUBMITTED|PAID/)
  })

  it('修改未知状态的支出时要求重新选择报销状态', async () => {
    const { table } = await renderApp({ statuses: { e2: 'LEGACY' } })

    fireEvent.click(within(table).getByRole('button', { name: '修改 商户2' }))
    const status = screen.getByLabelText('报销状态') as HTMLSelectElement

    // 不会看似选中第一项；required 让浏览器在提交前要求用户选择
    expect(status.value).toBe('')
    expect(status.required).toBe(true)
    expect(status.options[0].textContent).toBe('请选择报销状态')
    fireEvent.change(status, { target: { value: 'PAID' } })
    expect(Array.from(status.options, option => option.value)).not.toContain('')
  })

  it('Agent 支出查询结果与筛选条件中的报销状态显示中文', async () => {
    const result = {
      items: [{ id: 'x1', expense_date: '2025-03-01', amount_minor: 1200, merchant: '查询商户', category: '餐饮', status: 'PAID', allocated_minor: 0 }],
      total: 1, amount_minor: 1200, uncovered_minor: 1200, display_limit: 20, currency: 'CNY',
      filters_applied: { date_from: null, date_to: null, category: null, merchant: null, status: 'PAID', has_invoice: null, limit: 20 },
    }
    const toolMessage = { id: 'm1', role: 'tool', content: '', tool_name: 'query_expenses', tool_call_id: 'call1', tool_arguments: { status: 'PAID' }, tool_result: result, attachments: [], created_at: '2025-03-01T00:00:00' }
    await renderApp({ routes: {
      '/api/agent/conversations': [{ id: 'c1', title: '查询对话' }],
      '/api/agent/conversations/c1': { id: 'c1', title: '查询对话', messages: [toolMessage], pending_actions: [] },
    } })

    fireEvent.click(screen.getByRole('button', { name: 'Agent 对话' }))

    const card = (await screen.findByText('支出查询 · 1 笔')).closest('.agent-tool') as HTMLElement
    expect(within(card).getByText('状态：已到账')).toBeTruthy()
    expect(within(card).getByText('2025-03-01 · 餐饮 · 已到账')).toBeTruthy()
    expect(card.textContent).not.toContain('PAID')
  })
})

describe('对话模型切换', () => {
  it('切换模型后保持现有对话，关闭再打开仍选中该模型', async () => {
    mockBackend(25, { routes: {
      '/api/ai/settings': { configured: true, base_url: 'https://example.com/v1', model: 'model-a', models: ['model-a', 'model-b'], retention: 'keep' },
      '/api/agent/conversations': [{ id: 'c1', title: '原有对话' }],
      '/api/agent/conversations/c1': { id: 'c1', title: '原有对话', messages: [{ id: 'm1', role: 'assistant', content: '原有消息', attachments: [] }], pending_actions: [] },
    } })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Agent 对话' }))
    const dialog = await screen.findByRole('dialog', { name: 'Agent 对话' })
    await within(dialog).findByText('原有消息')
    const selector = within(dialog).getByRole('combobox', { name: '对话模型' }) as HTMLSelectElement
    expect(selector.value).toBe('model-a')
    fireEvent.change(selector, { target: { value: 'model-b' } })
    expect(within(dialog).getByText('原有消息')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭对话' }))
    expect(screen.queryByRole('dialog', { name: 'Agent 对话' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Agent 对话' }))
    expect((within(await screen.findByRole('dialog', { name: 'Agent 对话' })).getByRole('combobox', { name: '对话模型' }) as HTMLSelectElement).value).toBe('model-b')
    expect(within(dialog).getByText('原有消息')).toBeTruthy()
  })
})
