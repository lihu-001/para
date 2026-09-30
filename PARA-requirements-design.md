# PARA 需求与设计方案

## 1. 项目定义

**项目名称**：PARA  
**英文名称**：Personal AI Reimbursement Assistant  
**中文名称**：个人 AI 报销助手

PARA 是一个面向个人用户的支出、发票和报销管理工具，用于：

1. 记录个人日常支出；
2. 记录纸质或电子发票；
3. 将发票与支出进行关联；
4. 统计支出总金额、发票总金额和无发票金额；
5. 跟踪每笔支出的报销状态；
6. 借助 AI 从发票图片、PDF 或文本中提取信息；
7. 提醒用户补充发票、提交报销和跟踪报销进度。

---

# 2. 产品目标

## 2.1 核心目标

用户能够在一个系统中回答以下问题：

- 我一共花了多少钱？
- 哪些支出有发票？
- 哪些支出没有发票？
- 我的发票总金额是多少？
- 哪些支出已经报销？
- 哪些支出正在报销？
- 哪些支出还没有提交报销？
- 某张发票对应了哪些支出？
- 某笔支出是否已经有足额发票？
- 某个月、某个项目或某个类别的支出是多少？

## 2.2 非目标

第一阶段不处理：

- 企业财务总账；
- 多用户协同审批；
- 自动连接银行或信用卡账户；
- 自动向税务系统申报；
- 自动向企业报销系统提交数据；
- 复杂的会计凭证和借贷记账；
- 投资、收入、资产和负债管理。

这些能力可以作为后续扩展，但不应影响第一版的简单性和可用性。

---

# 3. 设计假设

如用户未特别指定，第一版采用以下默认约束：

| 项目 | 默认方案 |
|---|---|
| 用户类型 | 单用户 |
| 部署方式 | 本地优先，也可部署到个人服务器 |
| 默认币种 | 人民币 CNY |
| 多币种 | 数据模型支持，第一版界面可暂不开放 |
| 数据存储 | SQLite 或 PostgreSQL |
| 附件存储 | 本地文件系统或对象存储 |
| 登录 | 第一版可不设登录；远程部署时必须启用认证 |
| AI | 可插拔，不绑定单一模型服务 |
| 账务原则 | 支出、发票、报销三者独立建模 |
| 金额精度 | 使用整数分，不使用浮点数 |
| 删除策略 | 业务数据软删除或归档，附件不直接静默删除 |

---

# 4. 核心业务概念

PARA 中必须区分以下三个概念：

## 4.1 支出 Expense

表示用户实际发生的一笔消费或付款。

示例：

- 打车 35 元；
- 购买办公用品 128 元；
- 酒店住宿 680 元；
- 购买软件订阅 99 元。

一笔支出至少包含：

- 支出日期；
- 支出金额；
- 支出类别；
- 支付方式；
- 商户；
- 支出用途；
- 报销状态。

## 4.2 发票 Invoice

表示一张发票或其他报销凭证。

示例：

- 增值税电子普通发票；
- 增值税专用发票；
- 电子行程单；
- 出租车发票；
- 收据；
- 无发票证明；
- 其他凭证。

一张发票至少包含：

- 发票号码；
- 开票日期；
- 发票金额；
- 销售方；
- 发票类型；
- 发票文件或图片；
- OCR 提取结果；
- 验真或审核状态。

## 4.3 报销 Reimbursement

表示一组支出向某个组织或个人发起的报销流程。

一笔支出可以：

- 不参与任何报销；
- 参与一次报销；
- 被拆分到多次报销；
- 先提交后退回；
- 重新提交。

因此，报销不应只设计为支出上的一个简单布尔字段。

---

# 5. 关键业务规则

## 5.1 金额规则

所有金额必须使用整数分保存。

例如：

```text
35.80 元 -> 3580 分
```

禁止使用浮点数保存金额，避免出现浮点精度问题。

建议金额字段：

```text
amount_minor INTEGER NOT NULL
currency CHAR(3) NOT NULL DEFAULT 'CNY'
```

## 5.2 支出总金额

支出总金额为所有有效支出记录的金额之和。

不应包含：

- 已删除支出；
- 草稿记录；
- 被标记为无效的记录。

默认统计所有日期。用户可以按日期范围、类别、项目、商户、报销状态、币种和标签筛选。

## 5.3 发票总金额

发票总金额为所有有效发票记录的票面金额之和。

默认包括：

- 已上传但尚未审核的发票；
- 已审核通过的发票；
- 已关联支出和未关联支出的发票。

默认不包括：

- 已删除发票；
- 明确标记为作废的发票。

系统应同时展示：

- 发票总金额；
- 已关联金额；
- 未关联发票金额；
- 疑似重复发票金额；
- 作废发票金额。

## 5.4 无发票支出金额

不能简单使用：

```text
支出总金额 - 发票总金额
```

正确计算方式为逐笔计算：

```text
每笔支出金额 - 该支出已分配的有效发票金额
```

对小于零的结果按零计算：

```text
uncovered_amount = max(expense_amount - allocated_invoice_amount, 0)
```

同时保留异常金额：

```text
over_covered_amount = max(allocated_invoice_amount - expense_amount, 0)
```

这样可以发现错误关联或重复使用发票的问题。

## 5.5 发票关联规则

支持以下关系：

```text
一笔支出 <-> 多张发票
一张发票 <-> 多笔支出
```

中间表记录实际关联金额：

```text
expense_invoice_allocations
```

每条关联必须记录：

- 支出 ID；
- 发票 ID；
- 本次分配金额；
- 创建时间；
- 操作人；
- 备注。

系统必须阻止发票的已分配金额超过发票金额，并推荐阻止某笔支出的已分配金额超过支出金额。若存在特殊业务情况，应允许用户显式标记为“异常关联”，而不是静默放开约束。

---

# 6. 功能需求

## 6.1 仪表盘

首页展示核心数据卡片：

1. 本月支出总额；
2. 支出总额；
3. 发票总额；
4. 无发票金额；
5. 待报销金额；
6. 报销中金额；
7. 已报销金额；
8. 待处理发票数量。

建议增加以下图表：

- 按月份的支出趋势；
- 按类别的支出分布；
- 有票和无票支出比例；
- 报销状态分布；
- 按项目的支出统计；
- 发票关联完成度。

首页必须支持今天、本周、本月、上月、本季度、本年度和自定义日期范围。

## 6.2 支出管理

### 6.2.1 新增支出

字段：

| 字段 | 必填 | 说明 |
|---|---:|---|
| 支出日期 | 是 | 实际消费或付款日期 |
| 金额 | 是 | 支出金额 |
| 币种 | 是 | 默认 CNY |
| 商户名称 | 否 | 消费商家 |
| 类别 | 是 | 交通、住宿、餐饮等 |
| 项目 | 否 | 所属项目或任务 |
| 用途说明 | 否 | 支出目的 |
| 支付方式 | 否 | 现金、银行卡、微信、支付宝等 |
| 付款账户 | 否 | 可选 |
| 是否可报销 | 是 | 是、否、待确认 |
| 报销状态 | 是 | 未报销、报销中、已报销等 |
| 备注 | 否 | 补充信息 |
| 附件 | 否 | 收据、订单截图等 |

### 6.2.2 支出列表

支持分页、排序、类别/项目/报销状态/发票状态筛选、商户搜索、批量标记、批量导出和批量归档。

列表建议显示：

```text
日期 | 商户 | 类别 | 金额 | 已关联发票 | 无票金额 | 报销状态 | 操作
```

### 6.2.3 支出详情

详情页显示：

- 基础信息；
- 金额；
- 关联发票；
- 发票覆盖金额；
- 无发票金额；
- 报销记录；
- 附件；
- 操作历史；
- AI 识别建议；
- 修改记录。

## 6.3 发票管理

### 6.3.1 添加发票

支持手工录入、上传图片、上传 PDF、拍照上传和批量上传。邮件或文件夹导入可作为后续扩展。

发票字段：

| 字段 | 必填 | 说明 |
|---|---:|---|
| 发票类型 | 是 | 普票、专票、行程单、收据等 |
| 发票号码 | 否 | 某些凭证可能没有 |
| 发票代码 | 否 | 中国发票字段 |
| 开票日期 | 是 | 发票日期 |
| 票面金额 | 是 | 含税总额或凭证金额 |
| 不含税金额 | 否 | 可选 |
| 税额 | 否 | 可选 |
| 销售方 | 否 | 商户或开票方 |
| 购买方 | 否 | 可选 |
| 校验码 | 否 | 可选 |
| 来源 | 是 | 上传、手工、AI 导入等 |
| 审核状态 | 是 | 待审核、已确认、疑似错误、已作废 |
| 附件 | 否 | 原始文件 |
| 备注 | 否 | 补充说明 |

### 6.3.2 发票列表

建议显示：

```text
开票日期 | 销售方 | 发票号码 | 金额 | 已关联金额 | 剩余金额 | 审核状态 | 操作
```

支持按开票日期、金额、发票类型、审核状态和关联状态筛选，支持销售方/发票号码搜索、重复发票检测、批量导入和批量导出。

### 6.3.3 发票详情

详情页显示：

- 原始发票预览；
- OCR 识别结果；
- 用户确认后的结构化字段；
- 关联支出；
- 发票剩余可分配金额；
- 重复检测结果；
- 审核状态；
- 操作历史。

## 6.4 发票 OCR 与 AI 识别

### 6.4.1 识别目标

AI 或 OCR 服务尝试提取发票类型、发票代码、发票号码、开票日期、销售方、购买方、金额、不含税金额、税额、校验码、货币、图片质量和重复风险。

### 6.4.2 识别流程

```text
上传文件
  ↓
文件格式与大小校验
  ↓
生成文件哈希
  ↓
检测是否重复上传
  ↓
OCR/AI 识别
  ↓
字段标准化
  ↓
规则校验
  ↓
生成待确认发票
  ↓
用户确认
  ↓
正式入账
```

### 6.4.3 AI 结果原则

AI 提取的数据不能直接视为最终账务数据。必须区分：

```text
原始识别值
用户确认值
最终业务值
```

AI 需要返回字段级置信度：

```json
{
  "invoice_number": {
    "value": "12345678",
    "confidence": 0.96
  }
}
```

关键字段置信度低于阈值时，应要求用户确认。

### 6.4.4 AI 支出建议

AI 可以根据商户名称、支出描述、发票内容、历史分类和项目信息，建议支出类别、项目、是否可报销、可能关联的支出、可能关联的发票以及重复记录风险。

AI 只能提供建议，不得未经确认自动修改正式数据。

## 6.5 报销管理

### 6.5.1 报销状态

建议状态如下：

```text
NOT_REQUIRED      不需要报销
DRAFT             待提交
SUBMITTED         已提交
IN_REVIEW         审核中
RETURNED          已退回
APPROVED          已批准
PAID              已到账
CANCELLED         已取消
```

### 6.5.2 报销单

一个报销单可以包含多笔支出。

字段：

| 字段 | 说明 |
|---|---|
| 报销单号 | 系统自动生成 |
| 报销标题 | 用户填写 |
| 报销组织 | 公司、客户或其他 |
| 项目 | 所属项目 |
| 提交日期 | 提交时间 |
| 报销金额 | 包含的支出金额 |
| 有票金额 | 具备发票覆盖的金额 |
| 无票金额 | 缺少发票的金额 |
| 状态 | 当前状态 |
| 备注 | 补充说明 |
| 附件 | 报销单、审批截图等 |

### 6.5.3 状态转换

允许的基本转换：

```text
待提交 -> 已提交
已提交 -> 审核中
审核中 -> 已批准
审核中 -> 已退回
已批准 -> 已到账
已退回 -> 待提交
任意未完成状态 -> 已取消
```

系统必须记录原状态、新状态、操作时间、操作者和备注。不应允许用户直接从“待提交”跳转到“已到账”，除非通过明确授权的特殊操作。

## 6.6 分类、项目与标签

### 类别

系统预置类别：交通、住宿、餐饮、办公用品、软件订阅、通讯、差旅、培训、招待、其他。

类别必须允许用户新增、编辑和停用。停用类别不能用于新记录，但历史记录仍需保留。

### 项目

项目用于区分支出归属，例如项目 A、客户 B、个人办公、差旅和自由职业业务。

### 标签

标签用于记录非结构化属性，例如紧急、待补票、跨月、需要核验、可抵扣和个人垫付。

## 6.7 搜索、筛选与导出

支持搜索商户、发票号码、发票代码、支出说明、项目、标签和报销单号。

至少支持 CSV 导出，推荐支持 Excel。导出内容包括支出明细、发票明细、发票与支出关联明细、报销单和汇总统计。

导出时必须明确统计时间范围、当前筛选条件、币种、导出时间和数据版本。

---

# 7. 数据模型设计

以下以关系型数据库为例。

## 7.1 expenses 支出表

```sql
CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    expense_date DATE NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    currency CHAR(3) NOT NULL DEFAULT 'CNY',
    merchant_name TEXT,
    category_id TEXT,
    project_id TEXT,
    description TEXT,
    payment_method TEXT,
    account_name TEXT,
    reimbursement_required BOOLEAN NOT NULL DEFAULT TRUE,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    archived_at DATETIME,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
```

## 7.2 invoices 发票表

```sql
CREATE TABLE invoices (
    id TEXT PRIMARY KEY,
    invoice_type TEXT NOT NULL,
    invoice_code TEXT,
    invoice_number TEXT,
    issue_date DATE,
    total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor >= 0),
    tax_exclusive_amount_minor INTEGER,
    tax_amount_minor INTEGER,
    currency CHAR(3) NOT NULL DEFAULT 'CNY',
    seller_name TEXT,
    buyer_name TEXT,
    check_code TEXT,
    verification_status TEXT NOT NULL DEFAULT 'PENDING',
    source_type TEXT NOT NULL,
    file_id TEXT,
    ocr_result_json TEXT,
    archived_at DATETIME,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
```

## 7.3 expense_invoice_allocations 发票分配表

```sql
CREATE TABLE expense_invoice_allocations (
    id TEXT PRIMARY KEY,
    expense_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL,
    allocated_amount_minor INTEGER NOT NULL CHECK (allocated_amount_minor > 0),
    note TEXT,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,

    FOREIGN KEY (expense_id) REFERENCES expenses(id),
    FOREIGN KEY (invoice_id) REFERENCES invoices(id),

    UNIQUE (expense_id, invoice_id)
);
```

## 7.4 reimbursements 报销单表

```sql
CREATE TABLE reimbursements (
    id TEXT PRIMARY KEY,
    reimbursement_no TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    organization_name TEXT,
    project_id TEXT,
    submitted_at DATETIME,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    paid_at DATETIME,
    note TEXT,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);
```

## 7.5 reimbursement_expenses 报销单支出关联表

```sql
CREATE TABLE reimbursement_expenses (
    id TEXT PRIMARY KEY,
    reimbursement_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    reimbursed_amount_minor INTEGER NOT NULL CHECK (reimbursed_amount_minor > 0),
    created_at DATETIME NOT NULL,

    FOREIGN KEY (reimbursement_id) REFERENCES reimbursements(id),
    FOREIGN KEY (expense_id) REFERENCES expenses(id),

    UNIQUE (reimbursement_id, expense_id)
);
```

## 7.6 files 附件表

```sql
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    source_type TEXT,
    created_at DATETIME NOT NULL
);
```

## 7.7 categories、projects、tags

建议独立建表，不将类别和项目直接写死在业务表中。

---

# 8. 统计设计

## 8.1 单笔支出统计字段

对每笔支出动态计算：

```text
expense_amount
allocated_invoice_amount
uncovered_amount
over_covered_amount
reimbursed_amount
unreimbursed_amount
```

定义：

```text
allocated_invoice_amount = 该支出所有有效发票关联金额之和
uncovered_amount = max(expense_amount - allocated_invoice_amount, 0)
over_covered_amount = max(allocated_invoice_amount - expense_amount, 0)
reimbursed_amount = 该支出所有有效报销关联金额之和
unreimbursed_amount = max(expense_amount - reimbursed_amount, 0)
```

## 8.2 汇总统计

系统应提供：

```text
total_expense_amount
total_invoice_amount
total_allocated_invoice_amount
total_uncovered_expense_amount
total_over_covered_amount
total_reimbursement_pending_amount
total_reimbursement_in_review_amount
total_reimbursed_amount
```

## 8.3 统计过滤原则

统计 API 必须支持统一过滤参数：

```text
from
to
currency
category_id
project_id
reimbursement_status
invoice_status
include_archived
```

所有页面的统计数字必须使用同一套统计服务，避免仪表盘和列表出现口径不一致。

---

# 9. API 设计

推荐 REST API，也可使用 GraphQL。

## 9.1 支出 API

```http
GET    /api/expenses
POST   /api/expenses
GET    /api/expenses/{id}
PATCH  /api/expenses/{id}
DELETE /api/expenses/{id}
POST   /api/expenses/{id}/archive
```

## 9.2 发票 API

```http
GET    /api/invoices
POST   /api/invoices
GET    /api/invoices/{id}
PATCH  /api/invoices/{id}
DELETE /api/invoices/{id}
POST   /api/invoices/{id}/ocr
POST   /api/invoices/{id}/verify
```

## 9.3 关联 API

```http
GET    /api/expenses/{id}/invoices
POST   /api/expenses/{id}/invoices
DELETE /api/expenses/{id}/invoices/{invoiceId}

GET    /api/invoices/{id}/expenses
```

关联请求示例：

```json
{
  "invoice_id": "inv_123",
  "allocated_amount_minor": 3580,
  "note": "对应打车支出"
}
```

## 9.4 报销 API

```http
GET    /api/reimbursements
POST   /api/reimbursements
GET    /api/reimbursements/{id}
PATCH  /api/reimbursements/{id}
POST   /api/reimbursements/{id}/submit
POST   /api/reimbursements/{id}/transition
```

## 9.5 统计 API

```http
GET /api/dashboard/summary
GET /api/dashboard/trends
GET /api/dashboard/categories
GET /api/dashboard/reimbursement-status
```

统计响应示例：

```json
{
  "currency": "CNY",
  "total_expense_amount_minor": 125800,
  "total_invoice_amount_minor": 93600,
  "total_uncovered_amount_minor": 32200,
  "reimbursement_pending_amount_minor": 58000,
  "reimbursement_in_review_amount_minor": 30000,
  "reimbursed_amount_minor": 37800
}
```

---

# 10. 页面设计

## 10.1 页面结构

推荐导航：

```text
仪表盘
支出
发票
报销
统计
设置
```

## 10.2 仪表盘

布局：

```text
顶部：时间范围与筛选条件

第一行：
[支出总额] [发票总额] [无票金额] [待报销金额]

第二行：
[支出趋势图] [报销状态图]

第三行：
[待处理事项] [最近支出] [最近发票]
```

## 10.3 支出页面

支持表格视图和卡片视图。桌面端默认表格，移动端默认卡片。

## 10.4 发票上传交互

```text
拖拽文件
    ↓
上传进度
    ↓
AI 识别中
    ↓
显示识别结果
    ↓
用户确认字段
    ↓
保存发票
    ↓
推荐关联支出
```

## 10.5 支出与发票关联界面

关联页面应显示：

```text
支出金额：680.00 元
已关联发票：500.00 元
未覆盖金额：180.00 元
```

右侧提供候选发票：

```text
候选发票 | 销售方 | 日期 | 金额 | 剩余可分配金额 | 匹配原因
```

AI 匹配原因可以包括日期相近、商户名称相同、金额一致、描述相似和同一项目。用户必须手动确认关联。

---

# 11. AI 功能边界

## 11.1 AI 可以做什么

AI 可以：

- 识别发票字段；
- 识别图片中的文字；
- 建议支出类别；
- 建议项目；
- 推荐支出与发票关联；
- 检测重复发票；
- 检测金额异常；
- 生成报销摘要；
- 回答自然语言统计问题。

示例：

```text
“统计今年没有发票的差旅支出”
“找出还没有提交报销的支出”
“列出金额超过 500 元但没有发票的记录”
“生成 9 月项目 A 的报销摘要”
```

## 11.2 AI 不可以直接做什么

AI 默认不应直接：

- 删除支出；
- 删除发票；
- 修改金额；
- 修改发票号码；
- 改变报销状态；
- 自动提交报销；
- 自动确认发票关联；
- 代替用户确认 OCR 结果。

涉及账务、金额和报销状态的操作必须经过明确的用户确认。

## 11.3 自然语言查询

建议把自然语言转换为结构化查询条件：

```json
{
  "intent": "query_expenses",
  "filters": {
    "date_from": "2026-01-01",
    "date_to": "2026-09-28",
    "category": "交通",
    "has_invoice": false
  },
  "aggregation": "sum"
}
```

系统必须：

1. 展示 AI 解析出的查询条件；
2. 执行受限查询；
3. 返回结果和统计口径；
4. 不允许 AI 直接执行任意 SQL。

---

# 12. 数据一致性与异常处理

## 12.1 重复发票

建议优先使用以下组合检测重复：

```text
发票代码 + 发票号码
```

字段缺失时使用：

```text
文件 SHA-256
销售方 + 开票日期 + 金额
```

重复记录应标记为：

```text
DUPLICATE_SUSPECTED
```

而不是自动删除。

## 12.2 OCR 错误

OCR 可能把数字识别错误、遗漏小数点或截断发票号码。因此：

- 关键字段必须可编辑；
- 必须显示原始文件；
- 必须保留原始 OCR 结果；
- 用户确认后才正式保存。

## 12.3 发票金额与支出金额不一致

系统应允许金额不一致，但提示：

```text
发票金额小于支出金额
发票金额大于支出金额
```

不应自动修改任意一方金额。

## 12.4 跨币种

第一版建议限制一笔支出只能关联相同币种的发票。

未来支持汇率时增加：

```text
exchange_rate
converted_amount_minor
rate_date
rate_source
```

## 12.5 并发修改

未来支持多设备或远程部署时，更新接口应使用 `updated_at` 乐观锁或版本号 `version`。发生冲突时返回 `409 Conflict`，而不是静默覆盖。

---

# 13. 权限与安全

## 13.1 文件安全

- 限制上传文件类型；
- 限制文件大小；
- 校验 MIME 类型和文件扩展名；
- 文件名不能直接作为存储路径；
- 使用随机存储键；
- 防止路径穿越；
- 对上传文件计算 SHA-256；
- 下载文件必须经过权限检查。

## 13.2 敏感信息

发票可能包含姓名、纳税人识别号、地址、电话、银行信息和企业信息。

因此：

- 日志中不得打印完整发票内容；
- AI 请求前应明确数据是否离开本机；
- 可配置脱敏；
- API 必须具备认证；
- 数据库备份应加密。

## 13.3 审计日志

记录以下操作：

- 新增；
- 修改金额；
- 删除或归档；
- 发票确认；
- 发票关联；
- 报销状态变化；
- 文件上传；
- AI 建议采纳。

---

# 14. 技术架构建议

## 14.1 推荐架构

```text
Web UI
  ↓
Backend API
  ↓
Domain Services
  ├── Expense Service
  ├── Invoice Service
  ├── Allocation Service
  ├── Reimbursement Service
  ├── Statistics Service
  └── AI Service
  ↓
Database + File Storage
```

## 14.2 模块划分

### Expense Service

负责支出增删改查、支出分类、支出归档和支出金额校验。

### Invoice Service

负责发票增删改查、发票上传、OCR 处理、重复检测和发票审核。

### Allocation Service

负责支出与发票关联、分配金额校验、无票金额计算和超额覆盖检测。

### Reimbursement Service

负责报销单、状态流转、报销金额和报销历史。

### Statistics Service

负责汇总指标、趋势数据、分类统计、报销统计和统一统计口径。

### AI Service

负责 OCR、字段提取、分类建议、关联推荐和自然语言查询。AI 服务必须通过接口抽象，避免业务层直接依赖具体模型供应商。

---

# 15. 推荐技术栈

如果没有既定技术栈，可以采用：

```text
Frontend: React + TypeScript
Backend: FastAPI 或 NestJS
Database: SQLite，生产可迁移 PostgreSQL
File Storage: 本地目录，生产可迁移对象存储
OCR: 可插拔 OCR Provider
Deployment: Docker Compose
```

推荐采用单体 Web 应用：先实现响应式 Web 应用，兼容桌面和手机浏览器；未来再包装为桌面或移动应用。

也可选择：

- **桌面优先**：Tauri + React + SQLite，适合强调隐私和离线使用；
- **移动优先**：Flutter + Backend API + PostgreSQL + 对象存储，适合大量拍照录入，但第一版开发成本更高。

---

# 16. MVP 范围

第一版必须完成：

1. 支出新增、编辑、列表和详情；
2. 发票新增、编辑、列表和详情；
3. 发票附件上传；
4. 支出与发票多对多关联；
5. 无发票金额计算；
6. 报销状态管理；
7. 仪表盘核心统计；
8. 日期和状态筛选；
9. CSV 导出；
10. 基础数据校验；
11. 发票重复检测；
12. 基础审计记录。

第一版可以暂缓：

- 自动连接银行；
- 企业报销系统对接；
- 复杂审批流；
- 多用户协作；
- 高级 OCR；
- 自动发票验真；
- 移动端原生应用；
- 多币种汇率服务。

---

# 17. 测试要求

## 17.1 单元测试

必须覆盖：

- 金额转换；
- 金额加减；
- 无票金额计算；
- 发票分配金额校验；
- 超额覆盖检测；
- 报销状态转换；
- 重复发票检测；
- 日期范围统计。

## 17.2 集成测试

必须覆盖：

1. 创建支出；
2. 创建发票；
3. 将一张发票关联到多笔支出；
4. 将多张发票关联到一笔支出；
5. 计算无发票金额；
6. 创建报销单；
7. 添加支出到报销单；
8. 提交报销；
9. 退回后重新提交；
10. 导出统计数据。

## 17.3 关键验收场景

### 场景一：完整有票支出

```text
支出：100 元
发票：100 元
```

预期：

```text
无发票金额：0 元
超额覆盖金额：0 元
```

### 场景二：部分有票支出

```text
支出：100 元
发票：80 元
```

预期：

```text
无发票金额：20 元
```

### 场景三：一票多支出

```text
发票：100 元
支出 A：60 元
支出 B：40 元
```

预期：

```text
发票已分配金额：100 元
发票剩余金额：0 元
```

### 场景四：发票重复关联

```text
发票：100 元
第一次分配：100 元
第二次尝试分配：1 元
```

预期：

```text
操作失败
系统提示发票可分配余额不足
```

### 场景五：报销状态

```text
待提交 -> 已提交 -> 审核中 -> 已批准 -> 已到账
```

每个状态变更必须有历史记录。

---

# 18. 验收标准

项目完成后，用户至少能够：

- 创建一笔支出；
- 上传或录入一张发票；
- 将发票关联到支出；
- 查看支出剩余无票金额；
- 查看发票剩余可分配金额；
- 查看总支出金额；
- 查看总发票金额；
- 查看无发票支出金额；
- 查看待报销金额；
- 创建报销单；
- 更新报销状态；
- 按时间、类别和状态筛选；
- 导出支出和发票数据；
- 在错误关联时得到明确提示；
- 在 AI 识别错误时手工修正；
- 查看关键数据的来源和统计口径。

---

# 19. 给实现 AI 的约束说明

实现时应遵守以下规则：

1. 所有金额使用整数分存储，禁止浮点金额计算。
2. 支出、发票、报销必须独立建模。
3. 支出与发票通过关联表连接，不在支出表中只保留一个发票 ID。
4. “无发票金额”必须按逐笔支出计算，不能简单用总支出减总发票。
5. AI 识别结果必须经过用户确认。
6. AI 只能建议账务分类和关联，不能默认直接修改正式数据。
7. 报销状态必须使用明确的状态机。
8. 所有金额变化和报销状态变化必须可追溯。
9. 删除优先采用归档或软删除。
10. 所有列表、详情和统计页面必须使用统一的数据服务和统计口径。
11. API 必须校验关联金额，禁止发票被超额分配。
12. 业务层不能直接拼接任意 SQL 执行自然语言查询。
13. 附件必须使用随机存储路径，不能直接信任用户文件名。
14. 先完成可靠的手工录入流程，再接入 AI 自动化。
15. 第一版优先保证数据正确、金额正确和状态清晰，而不是追求复杂 AI 能力。
