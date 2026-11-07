/**
 * dsh-ssh-helper, browser half.
 *
 * One Settings section (`settings.section`, id `ssh-helper`, order 115) built
 * as an operational console: a left rail for Accounts / Deployments / Activity,
 * dense list rows, right-side detail and form sheets, a guarded-update note,
 * and a copy-to-agent bridge. The page never executes updates or rollbacks:
 * those stay approval-gated agent tools, so there is no update button here.
 *
 * The factory may request only `react`. Every control, icon and style is
 * authored here; secrets never leave dialog state and request bodies.
 *
 * @module dsh-ssh-helper/client
 */
window.__ModuleLoader__.load({
  // Must equal the package name: the client module graph keys factories by
  // manifest package name, so the loader row id (`ssh-helper`) is not enough.
  id: '@hunan36/dsh-ssh-helper',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement
    const LOCALE_NS = 'sshHelper'
    const STYLE_ID = 'dsh-ssh-helper-styles'
    const API_PREFIX = 'ssh-helper/api/'
    const LEGACY_DISMISS_KEY = 'dsh-ssh-helper:legacy-dismissed'

    function readLegacyDismissed() {
      try {
        return window.localStorage.getItem(LEGACY_DISMISS_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeLegacyDismissed() {
      try {
        window.localStorage.setItem(LEGACY_DISMISS_KEY, '1')
      } catch {
        /* storage is optional */
      }
    }

    // ---------------------------------------------------------------------
    // Utilities
    // ---------------------------------------------------------------------

    function fmt(t, key, params) {
      const value = t(key)
      if (typeof value !== 'string') return key
      return value.replace(/\{(\w+)\}/g, (match, name) => (
        params !== undefined && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ))
    }

    function text(value) {
      return value === undefined || value === null ? '' : String(value)
    }

    function cls() {
      const parts = []
      for (let index = 0; index < arguments.length; index += 1) {
        const value = arguments[index]
        if (typeof value === 'string' && value !== '') parts.push(value)
      }
      return parts.join(' ')
    }

    function errorMessage(caught, fallback) {
      if (caught !== null && typeof caught === 'object' && typeof caught.message === 'string' && caught.message !== '') return caught.message
      return fallback
    }

    async function call(method, body, signal) {
      let response
      try {
        response = await fetch(new URL(API_PREFIX + method, document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (caught) {
        const offline = new Error('network')
        offline.code = 'network'
        throw offline
      }
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        const failure = payload !== null && typeof payload === 'object' ? payload.error : undefined
        const message = failure !== undefined && typeof failure.message === 'string' && failure.message !== ''
          ? failure.message
          : `request failed (${response.status})`
        const error = new Error(message)
        error.code = failure !== undefined && typeof failure.code === 'string' ? failure.code : 'request-failed'
        throw error
      }
      return payload.data
    }

    async function copyText(value) {
      const source = text(value)
      if (source === '') return
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(source)
          return
        } catch {
          /* fall back to the selection copy below */
        }
      }
      const area = document.createElement('textarea')
      area.value = source
      area.setAttribute('readonly', 'true')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
      document.body.removeChild(area)
      if (!copied) throw new Error('copy failed')
    }

    function isEditable(target) {
      if (!target || typeof target !== 'object') return false
      const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      return target.isContentEditable === true
    }

    function isInside(parent, candidate) {
      if (typeof parent !== 'string' || typeof candidate !== 'string' || candidate === '') return false
      try {
        const normalizedParent = new URL(parent, 'file:///').pathname
        const normalizedCandidate = new URL(candidate, 'file:///').pathname
        return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(normalizedParent.replace(/\/$/, '') + '/')
      } catch {
        return false
      }
    }

    function statusMeta(status) {
      if (status === 'success') return { tone: 'success', key: 'statusSuccess' }
      if (status === 'partial') return { tone: 'warn', key: 'statusPartial' }
      if (status === 'failed') return { tone: 'error', key: 'statusFailed' }
      if (status === 'blocked') return { tone: 'error', key: 'statusBlocked' }
      return { tone: 'idle', key: 'statusNever' }
    }

    function matchStatusFilter(status, filter) {
      if (filter === 'all') return true
      if (filter === 'never') return status === undefined || status === null || status === ''
      if (filter === 'issues') return status === 'partial' || status === 'failed' || status === 'blocked'
      return status === filter
    }

    function formatRelative(iso, t) {
      if (typeof iso !== 'string' || iso === '') return t('statNone')
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return t('statNone')
      const diff = Date.now() - time
      const abs = Math.abs(diff)
      if (abs < 45_000) return t('relativeJustNow')
      const minutes = Math.max(1, Math.round(abs / 60_000))
      if (minutes < 60) return fmt(t, 'relativeMinutes', { count: minutes })
      const hours = Math.max(1, Math.round(minutes / 60))
      if (hours < 24) return fmt(t, 'relativeHours', { count: hours })
      const days = Math.max(1, Math.round(hours / 24))
      if (days < 31) return fmt(t, 'relativeDays', { count: days })
      return new Date(time).toLocaleDateString()
    }

    function formatDateTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return iso
      return new Date(time).toLocaleString()
    }

    function formatTimeOnly(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return iso
      return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    function formatDay(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return iso
      return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    }

    function formatDuration(value) {
      const ms = Number(value)
      if (!Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return `${Math.round(ms)} ms`
      if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
      return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
    }

    function groupHistoryByDay(entries) {
      const groups = []
      const index = new Map()
      for (const entry of entries) {
        const key = formatDay(entry.startedAt)
        if (!index.has(key)) {
          const group = { key, entries: [] }
          index.set(key, group)
          groups.push(group)
        }
        index.get(key).entries.push(entry)
      }
      return groups
    }

    function actionLabel(t, action) {
      if (action === 'rollback') return t('actionRollback')
      if (action === 'upload') return t('actionUpload')
      return t('actionApply')
    }

    function credentialLabel(t, account) {
      if (account.authType === 'key') return account.hasKey ? t('hasKey') : t('noSecret')
      return account.hasPassword ? t('hasPassword') : t('noSecret')
    }

    function sshCommand(account) {
      return `ssh -p ${account.port || 22} ${account.username}@${account.host}`
    }

    function promptForUpdate(t, resource) {
      return fmt(t, 'promptUpdate', { name: resource.name })
    }

    function promptForDiscovery(t) {
      return t('promptDiscovery')
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------

    const ICON_PARTS = {
      terminal: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }], ['path', { d: 'M7 9l3 3-3 3' }], ['path', { d: 'M13 15h4' }]],
      server: [['rect', { x: 3, y: 4, width: 18, height: 6.5, rx: 2 }], ['rect', { x: 3, y: 13.5, width: 18, height: 6.5, rx: 2 }], ['path', { d: 'M7 7.25h.01M7 16.75h.01' }]],
      history: [['path', { d: 'M3 12a9 9 0 1 0 3-6.7' }], ['path', { d: 'M3 4v5h5' }], ['path', { d: 'M12 8v4l3 2' }]],
      plus: [['path', { d: 'M12 5v14M5 12h14' }]],
      search: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'M16 16l4 4' }]],
      refresh: [['path', { d: 'M20 11a8 8 0 1 1-2.3-5.7' }], ['path', { d: 'M20 4v7h-7' }]],
      copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V5a2 2 0 0 1 2-2h10' }]],
      check: [['path', { d: 'M4 12.5l5 5L20 6.5' }]],
      x: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
      chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
      chevronDown: [['path', { d: 'M6 9l6 6 6-6' }]],
      edit: [['path', { d: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z' }], ['path', { d: 'M13.5 6.5l4 4' }]],
      trash: [['path', { d: 'M4 7h16' }], ['path', { d: 'M10 11v6M14 11v6' }], ['path', { d: 'M6 7l1 13h10l1-13' }], ['path', { d: 'M9 7V4h6v3' }]],
      play: [['path', { d: 'M8 5l11 7-11 7z' }]],
      shield: [['path', { d: 'M12 3l7 3v5.5c0 4.4-2.8 7.6-7 9.5-4.2-1.9-7-5.1-7-9.5V6z' }], ['path', { d: 'M9 12l2 2 4-4' }]],
      clock: [['circle', { cx: 12, cy: 12, r: 8 }], ['path', { d: 'M12 8v4l3 2' }]],
      alert: [['path', { d: 'M12 4l9 16H3z' }], ['path', { d: 'M12 10v4M12 17h.01' }]],
      folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
      key: [['circle', { cx: 8, cy: 15, r: 3.5 }], ['path', { d: 'M10.5 12.5L20 3M16 7l2 2M13 10l2 2' }]],
      lock: [['rect', { x: 5, y: 10, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 10V7a4 4 0 0 1 8 0v3' }]],
      dots: [['circle', { cx: 5, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 12, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 19, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }]],
    }

    function Icon(props) {
      const size = props.size === undefined ? 16 : props.size
      const parts = ICON_PARTS[props.name] || []
      return h('svg', {
        className: props.className,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, parts.map((part, index) => h(part[0], { key: index, ...part[1] })))
    }

    // ---------------------------------------------------------------------
    // Locale
    // ---------------------------------------------------------------------

    const zh = {
      nav: 'SSH 助手',
      title: 'SSH 助手',
      subtitle: '账户、部署目录与受控更新',
      approvalPill: '更新需审批',
      statServers: '服务器',
      statDeployments: '部署资源',
      statLastUpdate: '最近更新',
      statNone: '暂无记录',
      viewAccounts: '账户',
      viewDeployments: '部署资源',
      viewActivity: '更新记录',
      accountsTitle: '服务器账户',
      accountsSubtitle: '管理 SSH 连接；凭据只保存在本机宿主侧。',
      deploymentsTitle: '部署资源',
      deploymentsSubtitle: '采集到的服务目录、更新命令与备份策略。',
      activityTitle: '更新记录',
      activitySubtitle: '每次执行更新的步骤、耗时与输出。',
      addServer: '添加服务器',
      addDeployment: '添加部署',
      testAll: '全部测试',
      importTitle: '发现旧版账户',
      importDesc: '在 SSH Manager 中找到 {count} 个账户，可一键导入。',
      importAction: '导入 {count} 个',
      importing: '导入中…',
      dismiss: '忽略',
      searchAccounts: '搜索名称、主机或用户',
      searchDeployments: '搜索部署、服务器或目录',
      searchActivity: '搜索资源、服务器或状态',
      filterAll: '全部',
      filterSuccess: '成功',
      filterIssues: '异常',
      filterNever: '未更新',
      filterPartial: '部分完成',
      filterFailed: '失败',
      filterBlocked: '已阻塞',
      refresh: '刷新',
      loading: '正在加载…',
      loadFailed: '加载失败',
      retry: '重试',
      partialLoad: '部分数据加载失败，可刷新重试。',
      emptyAccountsTitle: '还没有服务器账户',
      emptyAccountsDesc: '添加一台 Linux 服务器，之后即可在会话中采集部署目录。',
      emptyDeploymentsTitle: '还没有部署资源',
      emptyDeploymentsDesc: '在会话中让智能体扫描服务器，或手动添加一个部署目录。',
      emptyDeploymentsNoServer: '先添加一台服务器，才能登记部署目录。',
      emptyActivityTitle: '还没有更新记录',
      emptyActivityDesc: '在会话中通过审批执行更新后，记录会出现在这里。',
      emptySearchTitle: '没有匹配结果',
      emptySearchDesc: '试试更短的关键词或清除筛选。',
      clearFilters: '清除筛选',
      goToAccounts: '去添加服务器',
      open: '查看',
      test: '测试',
      testing: '测试中…',
      testOk: '连接正常',
      testFail: '连接失败',
      edit: '编辑',
      delete: '删除',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      close: '关闭',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败',
      copySsh: '复制 SSH 命令',
      copyPath: '复制目录',
      copyCommand: '复制命令',
      copyUpdatePrompt: '复制更新提示词',
      copyDiscoveryPrompt: '复制采集提示词',
      deleteServerTitle: '删除服务器？',
      deleteServerDesc: '删除后，引用它的部署资源将无法更新。',
      deleteDeploymentTitle: '删除部署资源？',
      deleteDeploymentDesc: '只删除登记信息，不会改动远端目录或历史记录。',
      confirmDelete: '确认删除',
      deleting: '删除中…',
      accountAddTitle: '添加服务器',
      accountEditTitle: '编辑服务器',
      resourceAddTitle: '添加部署资源',
      resourceEditTitle: '编辑部署资源',
      accountDetail: '服务器详情',
      resourceDetail: '部署详情',
      sectionConnection: '连接',
      sectionDeployment: '部署',
      sectionCommands: '命令',
      sectionBackup: '备份',
      sectionDiscovery: '采集信息',
      sectionRecentActivity: '最近更新',
      sectionNote: '备注',
      sectionDanger: '危险操作',
      fieldName: '名称',
      fieldNameHint: '留空则使用 用户名@主机',
      fieldHost: '主机 / IP',
      fieldPort: '端口',
      fieldUsername: '用户名',
      fieldAuthType: '认证方式',
      authPassword: '密码',
      authKey: '私钥',
      fieldPassword: '密码',
      fieldPrivateKey: '私钥',
      fieldPassphrase: '私钥口令',
      fieldNote: '备注',
      fieldServer: '服务器',
      fieldServiceName: '服务名',
      fieldAppDir: '部署目录',
      fieldUpdate: '更新命令',
      fieldRestart: '重启命令',
      fieldVerify: '校验命令',
      fieldBackupEnabled: '更新前备份',
      fieldBackupDir: '备份目录',
      fieldBackupKeep: '保留份数',
      fieldTimeout: '超时（秒）',
      fieldTags: '标签',
      tagsHint: '用逗号分隔，例如 web, nginx',
      secretKeepHint: '留空表示保持已保存的凭据',
      secretRequiredHint: '首次添加或切换认证方式时必须填写',
      hasPassword: '已保存密码',
      hasKey: '已保存私钥',
      noSecret: '未保存凭据',
      testDraft: '测试连接',
      testDraftOk: '连接成功',
      testDraftFail: '连接失败',
      formHintAccount: '密码 / 私钥只保存在本机，不会出现在工具结果或日志中。',
      formHintResource: '这里只保存元数据与命令，不会执行任何远端操作。',
      validationRequired: '必填',
      validationHost: '请填写主机地址',
      validationPort: '端口需为 1–65535 的整数',
      validationUsername: '请填写用户名',
      validationPassword: '请填写密码',
      validationKey: '请粘贴私钥',
      validationName: '请填写名称',
      validationServer: '请选择服务器',
      validationAppDir: '请填写绝对路径，例如 /opt/web-api',
      validationUpdate: '请填写更新命令',
      validationBackupDir: '备份目录需为绝对路径',
      validationBackupKeep: '保留份数需为 1–50',
      validationTimeout: '超时需为 30–3600 秒',
      statusSuccess: '成功',
      statusPartial: '部分完成',
      statusFailed: '失败',
      statusBlocked: '已阻塞',
      statusNever: '未更新',
      statusTesting: '测试中',
      actionApply: '更新',
      actionRollback: '回滚',
      actionUpload: '上传',
      lastUpdated: '最近更新',
      neverUpdated: '尚未更新',
      updatedAt: '更新于',
      relativeJustNow: '刚刚',
      relativeMinutes: '{count} 分钟前',
      relativeHours: '{count} 小时前',
      relativeDays: '{count} 天前',
      unknown: '未知',
      unknownServer: '未知服务器',
      accountCount: '{count} 台服务器',
      deploymentCount: '{count} 个部署',
      historyCount: '{count} 条记录',
      backupOn: '已启用',
      backupOff: '未启用',
      backupKeepValue: '保留 {count} 份',
      timeoutValue: '{count} 秒',
      serviceValue: '服务 {name}',
      discoveredAt: '采集于 {time}',
      markers: '标记',
      gitRemote: 'Git 远程',
      gitBranch: '分支',
      serviceUnits: '服务单元',
      noDiscovery: '还没有采集信息。可以在会话中运行 ssh_helper_discover。',
      noActivity: '这个部署还没有更新记录。',
      viewAllActivity: '查看全部记录',
      steps: '步骤',
      exitCode: '退出码 {code}',
      duration: '耗时 {value}',
      output: '输出',
      stdout: 'stdout',
      stderr: 'stderr',
      noOutput: '（无输出）',
      showMore: '展开全部',
      showLess: '收起',
      approvalNote: '更新必须经过审批',
      approvalNoteDesc: '执行更新或回滚时，Harness 会要求你确认目标目录与命令；拒绝则不会发生任何远端变更。',
      toastSaved: '已保存',
      toastDeleted: '已删除',
      toastImported: '已导入 {imported} 个账户，跳过 {skipped} 个',
      toastTested: '连接测试完成',
      toastCopied: '已复制',
      toastCopyFailed: '复制失败',
      toastRefreshFailed: '刷新失败',
      toastLoadFailed: '加载失败',
      toastSaveFailed: '保存失败',
      toastDeleteFailed: '删除失败',
      toastTestFailed: '测试失败',
      toastImportFailed: '导入失败',
      legacyFound: '发现 {count} 个 SSH Manager 账户',
      legacyImported: '已导入 {count} 个账户',
      legacySkipped: '已跳过 {count} 个重复或无效账户',
      promptUpdate: '请为部署资源「{name}」生成更新计划：先调用 ssh_helper_update_plan 做只读预检，把计划给我确认；不要直接执行更新。',
      promptDiscovery: '请在已配置的 SSH 服务器上扫描部署目录，使用 ssh_helper_discover 的 scan 和 inspect，然后把选中的目录保存为部署资源。',
      promptCopied: '提示词已复制，可粘贴到会话中',
    }

    const en = {
      nav: 'SSH Helper',
      title: 'SSH Helper',
      subtitle: 'Accounts, deployment directories and guarded updates',
      approvalPill: 'Approval-gated',
      statServers: 'Servers',
      statDeployments: 'Deployments',
      statLastUpdate: 'Last update',
      statNone: 'No records',
      viewAccounts: 'Accounts',
      viewDeployments: 'Deployments',
      viewActivity: 'Activity',
      accountsTitle: 'Server accounts',
      accountsSubtitle: 'Manage SSH connections; credentials stay on the host.',
      deploymentsTitle: 'Deployment resources',
      deploymentsSubtitle: 'Discovered directories, update commands and backup policy.',
      activityTitle: 'Update activity',
      activitySubtitle: 'Steps, duration and output of every update run.',
      addServer: 'Add server',
      addDeployment: 'Add deployment',
      testAll: 'Test all',
      importTitle: 'Legacy accounts found',
      importDesc: '{count} accounts found in SSH Manager. Import them in one click.',
      importAction: 'Import {count}',
      importing: 'Importing…',
      dismiss: 'Dismiss',
      searchAccounts: 'Search name, host or user',
      searchDeployments: 'Search deployment, server or directory',
      searchActivity: 'Search resource, server or status',
      filterAll: 'All',
      filterSuccess: 'Success',
      filterIssues: 'Issues',
      filterNever: 'Never',
      filterPartial: 'Partial',
      filterFailed: 'Failed',
      filterBlocked: 'Blocked',
      refresh: 'Refresh',
      loading: 'Loading…',
      loadFailed: 'Failed to load',
      retry: 'Retry',
      partialLoad: 'Some data failed to load. Refresh to retry.',
      emptyAccountsTitle: 'No server accounts yet',
      emptyAccountsDesc: 'Add a Linux server, then discover deployment directories in a session.',
      emptyDeploymentsTitle: 'No deployments yet',
      emptyDeploymentsDesc: 'Ask the agent to scan a server in a session, or add a directory manually.',
      emptyDeploymentsNoServer: 'Add a server first to register a deployment directory.',
      emptyActivityTitle: 'No update activity yet',
      emptyActivityDesc: 'After an approval-gated update runs in a session, it appears here.',
      emptySearchTitle: 'No matches',
      emptySearchDesc: 'Try a shorter keyword or clear the filters.',
      clearFilters: 'Clear filters',
      goToAccounts: 'Go to accounts',
      open: 'Open',
      test: 'Test',
      testing: 'Testing…',
      testOk: 'Connected',
      testFail: 'Connection failed',
      edit: 'Edit',
      delete: 'Delete',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      close: 'Close',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      copySsh: 'Copy SSH command',
      copyPath: 'Copy directory',
      copyCommand: 'Copy command',
      copyUpdatePrompt: 'Copy update prompt',
      copyDiscoveryPrompt: 'Copy discovery prompt',
      deleteServerTitle: 'Delete server?',
      deleteServerDesc: 'Deployments that reference this server will no longer update.',
      deleteDeploymentTitle: 'Delete deployment?',
      deleteDeploymentDesc: 'Only the catalogue entry is removed; the remote directory and history stay.',
      confirmDelete: 'Delete',
      deleting: 'Deleting…',
      accountAddTitle: 'Add server',
      accountEditTitle: 'Edit server',
      resourceAddTitle: 'Add deployment',
      resourceEditTitle: 'Edit deployment',
      accountDetail: 'Server details',
      resourceDetail: 'Deployment details',
      sectionConnection: 'Connection',
      sectionDeployment: 'Deployment',
      sectionCommands: 'Commands',
      sectionBackup: 'Backup',
      sectionDiscovery: 'Discovered facts',
      sectionRecentActivity: 'Recent activity',
      sectionNote: 'Note',
      sectionDanger: 'Danger zone',
      fieldName: 'Name',
      fieldNameHint: 'Leave empty to use user@host',
      fieldHost: 'Host / IP',
      fieldPort: 'Port',
      fieldUsername: 'Username',
      fieldAuthType: 'Authentication',
      authPassword: 'Password',
      authKey: 'Private key',
      fieldPassword: 'Password',
      fieldPrivateKey: 'Private key',
      fieldPassphrase: 'Key passphrase',
      fieldNote: 'Note',
      fieldServer: 'Server',
      fieldServiceName: 'Service',
      fieldAppDir: 'Deployment directory',
      fieldUpdate: 'Update command',
      fieldRestart: 'Restart command',
      fieldVerify: 'Verify command',
      fieldBackupEnabled: 'Back up before update',
      fieldBackupDir: 'Backup directory',
      fieldBackupKeep: 'Backups to keep',
      fieldTimeout: 'Timeout (seconds)',
      fieldTags: 'Tags',
      tagsHint: 'Comma separated, e.g. web, nginx',
      secretKeepHint: 'Leave empty to keep the saved credential',
      secretRequiredHint: 'Required for a new account or when switching authentication',
      hasPassword: 'Password saved',
      hasKey: 'Key saved',
      noSecret: 'No credential',
      testDraft: 'Test connection',
      testDraftOk: 'Connected',
      testDraftFail: 'Connection failed',
      formHintAccount: 'Passwords and keys stay on this host; they never appear in tool results or logs.',
      formHintResource: 'Only metadata and commands are saved here. Nothing runs on the remote host.',
      validationRequired: 'Required',
      validationHost: 'Enter a host',
      validationPort: 'Port must be an integer from 1 to 65535',
      validationUsername: 'Enter a username',
      validationPassword: 'Enter a password',
      validationKey: 'Paste a private key',
      validationName: 'Enter a name',
      validationServer: 'Choose a server',
      validationAppDir: 'Enter an absolute path, e.g. /opt/web-api',
      validationUpdate: 'Enter an update command',
      validationBackupDir: 'Backup directory must be absolute',
      validationBackupKeep: 'Keep between 1 and 50 backups',
      validationTimeout: 'Timeout must be 30–3600 seconds',
      statusSuccess: 'Success',
      statusPartial: 'Partial',
      statusFailed: 'Failed',
      statusBlocked: 'Blocked',
      statusNever: 'Never',
      statusTesting: 'Testing',
      actionApply: 'Update',
      actionRollback: 'Rollback',
      actionUpload: 'Upload',
      lastUpdated: 'Last update',
      neverUpdated: 'Never updated',
      updatedAt: 'Updated',
      relativeJustNow: 'just now',
      relativeMinutes: '{count} min ago',
      relativeHours: '{count} h ago',
      relativeDays: '{count} d ago',
      unknown: 'Unknown',
      unknownServer: 'Unknown server',
      accountCount: '{count} servers',
      deploymentCount: '{count} deployments',
      historyCount: '{count} records',
      backupOn: 'Enabled',
      backupOff: 'Disabled',
      backupKeepValue: 'Keep {count}',
      timeoutValue: '{count} s',
      serviceValue: 'Service {name}',
      discoveredAt: 'Discovered {time}',
      markers: 'Markers',
      gitRemote: 'Git remote',
      gitBranch: 'Branch',
      serviceUnits: 'Service units',
      noDiscovery: 'No discovery facts yet. Run ssh_helper_discover in a session.',
      noActivity: 'This deployment has no update activity yet.',
      viewAllActivity: 'View all activity',
      steps: 'Steps',
      exitCode: 'Exit {code}',
      duration: 'Duration {value}',
      output: 'Output',
      stdout: 'stdout',
      stderr: 'stderr',
      noOutput: '(no output)',
      showMore: 'Show all',
      showLess: 'Show less',
      approvalNote: 'Updates need approval',
      approvalNoteDesc: 'Before an update or rollback, Harness asks you to confirm the directory and command. Rejecting it changes nothing remotely.',
      toastSaved: 'Saved',
      toastDeleted: 'Deleted',
      toastImported: 'Imported {imported} accounts, skipped {skipped}',
      toastTested: 'Connection tests finished',
      toastCopied: 'Copied',
      toastCopyFailed: 'Copy failed',
      toastRefreshFailed: 'Refresh failed',
      toastLoadFailed: 'Failed to load',
      toastSaveFailed: 'Save failed',
      toastDeleteFailed: 'Delete failed',
      toastTestFailed: 'Test failed',
      toastImportFailed: 'Import failed',
      legacyFound: '{count} SSH Manager accounts found',
      legacyImported: '{count} accounts imported',
      legacySkipped: '{count} duplicate or invalid accounts skipped',
      promptUpdate: 'Plan an update for deployment "{name}": call ssh_helper_update_plan for a read-only preflight first, show me the plan, and do not execute the update directly.',
      promptDiscovery: 'Scan the configured SSH servers for deployment directories with ssh_helper_discover (scan and inspect), then save the selected directory as a deployment resource.',
      promptCopied: 'Prompt copied; paste it into a session',
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const CSS = `
.dsh-ssh-helper-page {
  /* Theme tokens live on the page root because the side sheet is a sibling
     of the section node; defining them on .dsh-ssh-helper-section left every
     --ssh-* reference inside the sheet unresolved. */
  --ssh-accent: var(--dsw-alias-brand-primary, #2b7cd3);
  --ssh-success: var(--dsw-alias-state-success-primary, #12805c);
  --ssh-warn: var(--dsw-alias-state-warn-primary, #b54708);
  --ssh-error: var(--dsw-alias-state-error-primary, #d92d20);
  --ssh-idle: var(--dsw-alias-state-idle-primary, #8e8e93);
  --ssh-text: var(--dsw-alias-label-primary, #1d1d1f);
  --ssh-text-2: var(--dsw-alias-label-secondary, #6e6e73);
  --ssh-text-3: var(--dsw-alias-label-tertiary, #8e8e93);
  --ssh-bg: var(--dsw-alias-bg-base, #ffffff);
  --ssh-on-accent: var(--dsw-alias-label-primary-foreground, #ffffff);
  --ssh-layer-1: var(--dsw-alias-bg-layer-1, #ffffff);
  --ssh-layer-2: var(--dsw-alias-bg-layer-2, #f5f5f7);
  --ssh-layer-3: var(--dsw-alias-bg-layer-3, #ececf0);
  --ssh-border: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  --ssh-border-2: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
  --ssh-hover: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.045));
  --ssh-radius: 12px;
  --ssh-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: calc(24px + var(--dsh-frame-top-clearance, 0px)) max(18px, min(4vw, 44px)) 40px;
  color: var(--ssh-text);
  font-size: 13px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}
.dsh-ssh-helper-section {
  max-width: 1180px;
  margin: 0 auto;
  width: 100%;
}
:where(.dsh-ssh-helper-page) *,
:where(.dsh-ssh-helper-page) *::before,
:where(.dsh-ssh-helper-page) *::after { box-sizing: border-box; }
:where(.dsh-ssh-helper-page) button,
:where(.dsh-ssh-helper-page) input,
:where(.dsh-ssh-helper-page) textarea,
:where(.dsh-ssh-helper-page) select { font: inherit; color: inherit; }
:where(.dsh-ssh-helper-page) button { cursor: pointer; }
.dsh-ssh-helper-shell { display: flex; flex-direction: column; gap: 16px; }
.dsh-ssh-helper-hero {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 20px;
  border: 1px solid var(--ssh-border);
  border-radius: 16px;
  background:
    radial-gradient(120% 150% at 0% 0%, color-mix(in srgb, var(--ssh-accent) 12%, transparent), transparent 58%),
    var(--ssh-layer-1);
}
.dsh-ssh-helper-hero::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: linear-gradient(color-mix(in srgb, var(--ssh-border) 45%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--ssh-border) 45%, transparent) 1px, transparent 1px);
  background-size: 26px 26px;
  mask-image: linear-gradient(120deg, transparent 35%, #000 100%);
  opacity: 0.45;
}
.dsh-ssh-helper-hero-main { display: flex; flex-direction: column; gap: 10px; position: relative; z-index: 1; min-width: 0; }
.dsh-ssh-helper-brand { display: flex; align-items: center; gap: 12px; }
.dsh-ssh-helper-brand-mark {
  width: 40px;
  height: 40px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 12px;
  color: var(--ssh-on-accent);
  background: linear-gradient(135deg, var(--ssh-accent), color-mix(in srgb, var(--ssh-accent) 42%, var(--dsw-alias-bg-overlay, #061423)));
  box-shadow: 0 8px 20px -12px color-mix(in srgb, var(--ssh-accent) 70%, transparent);
}
.dsh-ssh-helper-brand h2 { margin: 0; font-size: 18px; letter-spacing: -0.015em; font-weight: 650; }
.dsh-ssh-helper-brand p { margin: 2px 0 0; color: var(--ssh-text-2); font-size: 12px; }
.dsh-ssh-helper-hero-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 4px 9px;
  border: 1px solid color-mix(in srgb, var(--ssh-accent) 28%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ssh-accent) 9%, transparent);
  color: var(--ssh-accent);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.dsh-ssh-helper-stats { position: relative; z-index: 1; display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap; }
.dsh-ssh-helper-stat {
  min-width: 92px;
  padding: 8px 11px;
  border: 1px solid var(--ssh-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ssh-layer-1) 78%, transparent);
  backdrop-filter: blur(4px);
}
.dsh-ssh-helper-stat-label { display: block; font-size: 10px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--ssh-text-3); font-weight: 700; }
.dsh-ssh-helper-stat-value { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 14px; font-weight: 650; white-space: nowrap; }
.dsh-ssh-helper-console { display: grid; grid-template-columns: 166px minmax(0, 1fr); gap: 16px; align-items: start; }
.dsh-ssh-helper-rail {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--ssh-border);
  border-radius: 14px;
  background: var(--ssh-layer-1);
}
.dsh-ssh-helper-rail-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--ssh-text-2);
  text-align: left;
  transition: background 140ms ease, color 140ms ease;
}
.dsh-ssh-helper-rail-item:hover { background: var(--ssh-hover); color: var(--ssh-text); }
.dsh-ssh-helper-rail-item[aria-current="page"] {
  background: color-mix(in srgb, var(--ssh-accent) 11%, transparent);
  color: var(--ssh-text);
  box-shadow: inset 3px 0 0 var(--ssh-accent);
}
.dsh-ssh-helper-rail-item[aria-current="page"] .dsh-ssh-helper-rail-icon { color: var(--ssh-accent); }
.dsh-ssh-helper-rail-icon { display: grid; place-items: center; color: var(--ssh-text-3); }
.dsh-ssh-helper-rail-label { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; }
.dsh-ssh-helper-rail-count {
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--ssh-layer-2);
  color: var(--ssh-text-2);
  font-size: 10.5px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.dsh-ssh-helper-rail-note {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-top: 6px;
  padding: 10px 8px 4px;
  border-top: 1px dashed var(--ssh-border);
  color: var(--ssh-text-3);
  font-size: 10.5px;
  line-height: 1.45;
}
.dsh-ssh-helper-rail-note svg { flex: none; margin-top: 1px; color: var(--ssh-accent); }
.dsh-ssh-helper-rail-note strong { display: block; color: var(--ssh-text-2); font-size: 10.5px; font-weight: 650; }
.dsh-ssh-helper-main { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.dsh-ssh-helper-view { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dsh-ssh-helper-view-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsh-ssh-helper-view-head h3 { margin: 0; font-size: 15px; letter-spacing: -0.01em; font-weight: 650; }
.dsh-ssh-helper-view-head p { margin: 3px 0 0; color: var(--ssh-text-2); font-size: 12px; max-width: 52ch; }
.dsh-ssh-helper-view-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-ssh-helper-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-ssh-helper-search { position: relative; flex: 1; min-width: 170px; }
.dsh-ssh-helper-search > svg { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--ssh-text-3); pointer-events: none; }
.dsh-ssh-helper-search input {
  width: 100%;
  height: 32px;
  padding: 0 10px 0 31px;
  border: 1px solid var(--ssh-border);
  border-radius: 8px;
  background: var(--ssh-layer-1);
  color: var(--ssh-text);
  outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.dsh-ssh-helper-search input::placeholder { color: var(--ssh-text-3); }
.dsh-ssh-helper-search input:focus { border-color: color-mix(in srgb, var(--ssh-accent) 55%, var(--ssh-border)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ssh-accent) 15%, transparent); }
.dsh-ssh-helper-filter-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dsh-ssh-helper-filter {
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--ssh-text-2);
  font-size: 11.5px;
  font-weight: 600;
}
.dsh-ssh-helper-filter:hover { background: var(--ssh-hover); color: var(--ssh-text); }
.dsh-ssh-helper-filter[aria-pressed="true"] { border-color: color-mix(in srgb, var(--ssh-accent) 30%, transparent); background: color-mix(in srgb, var(--ssh-accent) 10%, transparent); color: var(--ssh-accent); }
.dsh-ssh-helper-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--ssh-border); border-radius: var(--ssh-radius); background: var(--ssh-layer-1); overflow: hidden; }
.dsh-ssh-helper-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  min-height: 58px;
  border-bottom: 1px solid var(--ssh-border);
  transition: background 140ms ease;
}
.dsh-ssh-helper-row:last-child { border-bottom: 0; }
.dsh-ssh-helper-row:hover { background: var(--ssh-hover); }
.dsh-ssh-helper-row.is-selected { background: color-mix(in srgb, var(--ssh-accent) 7%, transparent); }
.dsh-ssh-helper-row-hit {
  display: flex;
  align-items: center;
  gap: 11px;
  flex: 1;
  min-width: 0;
  align-self: stretch;
  padding: 9px 0;
  border: 0;
  background: transparent;
  text-align: left;
  color: inherit;
}
.dsh-ssh-helper-row-hit:focus-visible { outline: 2px solid var(--ssh-accent); outline-offset: -2px; border-radius: 8px; }
.dsh-ssh-helper-avatar {
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid var(--ssh-border);
  border-radius: 9px;
  background: var(--ssh-layer-2);
  color: var(--ssh-text-2);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.dsh-ssh-helper-row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.dsh-ssh-helper-row-title { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; font-weight: 620; }
.dsh-ssh-helper-row-title > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ssh-helper-row-sub { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ssh-text-2); font-size: 11.5px; }
.dsh-ssh-helper-row-sub .dsh-ssh-helper-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ssh-helper-row-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ssh-text-3); }
.dsh-ssh-helper-row-side { display: flex; align-items: center; gap: 7px; flex: none; }
.dsh-ssh-helper-row-actions { display: flex; align-items: center; gap: 1px; opacity: 0; transition: opacity 120ms ease; }
.dsh-ssh-helper-row:hover .dsh-ssh-helper-row-actions,
.dsh-ssh-helper-row:focus-within .dsh-ssh-helper-row-actions { opacity: 1; }
.dsh-ssh-helper-row-time { color: var(--ssh-text-3); font-size: 11px; white-space: nowrap; }
.dsh-ssh-helper-mono { font-family: var(--ssh-mono); font-size: 0.94em; }
.dsh-ssh-helper-muted { color: var(--ssh-text-2); }
.dsh-ssh-helper-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ssh-helper-sep { color: var(--ssh-text-3); }
.dsh-ssh-helper-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--ssh-border);
  border-radius: 999px;
  background: var(--ssh-layer-2);
  color: var(--ssh-text-2);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}
.dsh-ssh-helper-chip--success { border-color: color-mix(in srgb, var(--ssh-success) 28%, transparent); background: color-mix(in srgb, var(--ssh-success) 10%, transparent); color: var(--ssh-success); }
.dsh-ssh-helper-chip--warn { border-color: color-mix(in srgb, var(--ssh-warn) 30%, transparent); background: color-mix(in srgb, var(--ssh-warn) 10%, transparent); color: var(--ssh-warn); }
.dsh-ssh-helper-chip--error { border-color: color-mix(in srgb, var(--ssh-error) 28%, transparent); background: color-mix(in srgb, var(--ssh-error) 9%, transparent); color: var(--ssh-error); }
.dsh-ssh-helper-chip--brand { border-color: color-mix(in srgb, var(--ssh-accent) 30%, transparent); background: color-mix(in srgb, var(--ssh-accent) 9%, transparent); color: var(--ssh-accent); }
.dsh-ssh-helper-chip--idle { color: var(--ssh-text-3); }
.dsh-ssh-helper-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent);
}
.dsh-ssh-helper-dot--success { color: var(--ssh-success); }
.dsh-ssh-helper-dot--warn { color: var(--ssh-warn); }
.dsh-ssh-helper-dot--error { color: var(--ssh-error); }
.dsh-ssh-helper-dot--idle { color: var(--ssh-idle); }
.dsh-ssh-helper-dot--pulse { animation: dsh-ssh-helper-pulse 1.1s ease-in-out infinite; }
.dsh-ssh-helper-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--ssh-border);
  border-radius: 7px;
  background: var(--ssh-layer-1);
  color: var(--ssh-text);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background 120ms ease, border-color 120ms ease, transform 80ms ease, opacity 120ms ease;
}
.dsh-ssh-helper-btn:hover { background: var(--ssh-layer-2); }
.dsh-ssh-helper-btn:active { transform: scale(0.985); }
.dsh-ssh-helper-btn:focus-visible { outline: 2px solid var(--ssh-accent); outline-offset: 2px; }
.dsh-ssh-helper-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.dsh-ssh-helper-btn.dsh-ssh-helper-btn--primary {
  border-color: var(--dsw-alias-button-primary-fill, var(--ssh-accent));
  background: var(--dsw-alias-button-primary-fill, var(--ssh-accent));
  color: #ffffff;
  color: var(--ssh-on-accent, #ffffff);
  box-shadow: 0 6px 14px -10px color-mix(in srgb, var(--ssh-accent) 80%, transparent);
}
.dsh-ssh-helper-btn.dsh-ssh-helper-btn--primary > span,
.dsh-ssh-helper-btn.dsh-ssh-helper-btn--primary > svg { color: #ffffff; color: var(--ssh-on-accent, #ffffff); }
.dsh-ssh-helper-btn.dsh-ssh-helper-btn--primary:hover { border-color: var(--dsw-alias-button-primary-hover, var(--ssh-accent)); background: var(--dsw-alias-button-primary-hover, color-mix(in srgb, var(--ssh-accent) 88%, var(--ssh-text))); }
.dsh-ssh-helper-btn--ghost { border-color: transparent; background: transparent; color: var(--ssh-text-2); }
.dsh-ssh-helper-btn--ghost:hover { background: var(--ssh-hover); color: var(--ssh-text); }
.dsh-ssh-helper-btn--danger { border-color: color-mix(in srgb, var(--ssh-error) 30%, transparent); background: color-mix(in srgb, var(--ssh-error) 8%, transparent); color: var(--ssh-error); }
.dsh-ssh-helper-btn--danger:hover { background: color-mix(in srgb, var(--ssh-error) 14%, transparent); }
.dsh-ssh-helper-btn--icon { width: 27px; height: 27px; padding: 0; border-color: transparent; background: transparent; color: var(--ssh-text-3); }
.dsh-ssh-helper-btn--icon:hover { background: var(--ssh-hover); color: var(--ssh-text); }
.dsh-ssh-helper-btn--sm { height: 26px; padding: 0 8px; font-size: 11.5px; }
.dsh-ssh-helper-spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border: 1.6px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: dsh-ssh-helper-spin 0.7s linear infinite;
}
.dsh-ssh-helper-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--ssh-accent) 25%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ssh-accent) 7%, transparent);
  color: var(--ssh-text-2);
  font-size: 11.5px;
}
.dsh-ssh-helper-banner > svg { flex: none; color: var(--ssh-accent); }
.dsh-ssh-helper-banner strong { color: var(--ssh-text); font-weight: 650; }
.dsh-ssh-helper-banner-actions { margin-left: auto; display: flex; gap: 6px; flex: none; }
.dsh-ssh-helper-error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--ssh-error) 28%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ssh-error) 7%, transparent);
  color: var(--ssh-error);
  font-size: 11.5px;
}
.dsh-ssh-helper-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 52px 24px;
  border: 1px dashed var(--ssh-border-2);
  border-radius: var(--ssh-radius);
  background: color-mix(in srgb, var(--ssh-layer-1) 65%, transparent);
  text-align: center;
}
.dsh-ssh-helper-empty-mark {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid var(--ssh-border);
  border-radius: 13px;
  background: var(--ssh-layer-2);
  color: var(--ssh-text-3);
}
.dsh-ssh-helper-empty h4 { margin: 0; font-size: 14px; font-weight: 650; }
.dsh-ssh-helper-empty p { margin: 0; max-width: 44ch; color: var(--ssh-text-2); font-size: 12px; }
.dsh-ssh-helper-empty-actions { display: flex; gap: 7px; flex-wrap: wrap; justify-content: center; margin-top: 4px; }
.dsh-ssh-helper-skeleton { display: flex; flex-direction: column; gap: 8px; }
.dsh-ssh-helper-skeleton-row { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px solid var(--ssh-border); border-radius: 10px; background: var(--ssh-layer-1); }
.dsh-ssh-helper-skeleton-block {
  border-radius: 6px;
  background: linear-gradient(90deg, var(--ssh-layer-2) 25%, var(--ssh-layer-3) 37%, var(--ssh-layer-2) 63%);
  background-size: 400% 100%;
  animation: dsh-ssh-helper-shimmer 1.4s ease infinite;
}
.dsh-ssh-helper-skeleton-avatar { width: 32px; height: 32px; border-radius: 9px; flex: none; }
.dsh-ssh-helper-skeleton-lines { display: flex; flex-direction: column; gap: 7px; flex: 1; }
.dsh-ssh-helper-skeleton-line { height: 9px; }
.dsh-ssh-helper-skeleton-line.is-short { width: 42%; }
.dsh-ssh-helper-footnote { margin: 0; color: var(--ssh-text-3); font-size: 10.5px; display: flex; align-items: center; gap: 6px; }
.dsh-ssh-helper-footnote svg { flex: none; }
.dsh-ssh-helper-sheet-root { position: fixed; inset: 0; z-index: 1000; display: flex; justify-content: flex-end; }
.dsh-ssh-helper-scrim { position: absolute; inset: 0; background: rgba(8, 11, 16, 0.42); -webkit-backdrop-filter: blur(4px) saturate(0.9); backdrop-filter: blur(4px) saturate(0.9); animation: dsh-ssh-helper-fade-in 160ms ease; }
.dsh-ssh-helper-sheet {
  position: relative;
  width: min(450px, 100vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--ssh-border-2);
  background-color: var(--dsw-alias-bg-base, #ffffff);
  background-image: linear-gradient(var(--ssh-layer-1), var(--ssh-layer-1));
  box-shadow: -32px 0 80px -36px rgba(0, 0, 0, 0.55), -1px 0 0 rgba(0, 0, 0, 0.04);
  animation: dsh-ssh-helper-slide-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.dsh-ssh-helper-sheet.is-wide { width: min(530px, 100vw); }
.dsh-ssh-helper-sheet-head { display: flex; align-items: flex-start; gap: 10px; padding: 17px 18px 13px; border-bottom: 1px solid var(--ssh-border); }
.dsh-ssh-helper-sheet-head h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
.dsh-ssh-helper-sheet-head p { margin: 2px 0 0; color: var(--ssh-text-2); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.dsh-ssh-helper-sheet-head .dsh-ssh-helper-btn { margin-left: auto; flex: none; }
.dsh-ssh-helper-sheet-body { flex: 1; overflow: auto; padding: 16px 18px 24px; overscroll-behavior: contain; scrollbar-gutter: stable; }
.dsh-ssh-helper-detail { display: flex; flex-direction: column; gap: 2px; }
.dsh-ssh-helper-detail-summary { display: flex; align-items: center; gap: 10px; padding-bottom: 12px; border-bottom: 1px solid var(--ssh-border); }
.dsh-ssh-helper-detail-summary .dsh-ssh-helper-avatar { width: 36px; height: 36px; }
.dsh-ssh-helper-detail-title { min-width: 0; flex: 1; }
.dsh-ssh-helper-detail-title h3 { margin: 0; font-size: 14px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ssh-helper-detail-title p { margin: 2px 0 0; color: var(--ssh-text-2); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ssh-helper-detail-actions { display: flex; gap: 6px; flex-wrap: wrap; padding: 12px 0 2px; }
.dsh-ssh-helper-section-label { display: flex; align-items: center; gap: 6px; margin: 16px 0 7px; color: var(--ssh-text-3); font-size: 10px; font-weight: 700; letter-spacing: 0.11em; text-transform: uppercase; }
.dsh-ssh-helper-meta { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 7px 12px; align-items: start; }
.dsh-ssh-helper-meta-row { display: contents; }
.dsh-ssh-helper-meta-label { color: var(--ssh-text-3); font-size: 11.5px; }
.dsh-ssh-helper-meta-value { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; }
.dsh-ssh-helper-meta-value .dsh-ssh-helper-truncate { min-width: 0; }
.dsh-ssh-helper-code { border: 1px solid var(--ssh-border); border-radius: 8px; background: var(--ssh-layer-2); overflow: hidden; }
.dsh-ssh-helper-code + .dsh-ssh-helper-code { margin-top: 7px; }
.dsh-ssh-helper-code-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px 5px 10px; border-bottom: 1px solid var(--ssh-border); color: var(--ssh-text-3); font-size: 10.5px; font-weight: 650; letter-spacing: 0.02em; }
.dsh-ssh-helper-code-head-actions { display: flex; align-items: center; gap: 2px; }
.dsh-ssh-helper-code pre {
  margin: 0;
  padding: 9px 10px;
  max-height: 170px;
  overflow: auto;
  color: var(--ssh-text);
  font-family: var(--ssh-mono);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.dsh-ssh-helper-code.is-expanded pre { max-height: none; }
.dsh-ssh-helper-output { margin-top: 7px; border: 1px solid var(--ssh-border); border-radius: 8px; background: var(--ssh-layer-3); overflow: hidden; }
.dsh-ssh-helper-output-label { padding: 4px 9px; border-bottom: 1px solid var(--ssh-border); color: var(--ssh-text-3); font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.dsh-ssh-helper-output pre { margin: 0; padding: 8px 10px; max-height: 190px; overflow: auto; font-family: var(--ssh-mono); font-size: 10.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.dsh-ssh-helper-form { display: flex; flex-direction: column; gap: 12px; }
.dsh-ssh-helper-form-hint { margin: 0; color: var(--ssh-text-3); font-size: 10.5px; line-height: 1.5; }
.dsh-ssh-helper-grid-2 { display: grid; grid-template-columns: minmax(0, 1fr) 92px; gap: 8px; }
.dsh-ssh-helper-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsh-ssh-helper-field > label { color: var(--ssh-text-2); font-size: 11.5px; font-weight: 620; }
.dsh-ssh-helper-field-hint { color: var(--ssh-text-3); font-size: 10.5px; }
.dsh-ssh-helper-field-error { color: var(--ssh-error); font-size: 10.5px; }
.dsh-ssh-helper-required { color: var(--ssh-error); font-weight: 700; }
.dsh-ssh-helper-input,
.dsh-ssh-helper-textarea,
.dsh-ssh-helper-select {
  width: 100%;
  border: 1px solid color-mix(in srgb, var(--ssh-text) 22%, transparent);
  border-radius: 7px;
  background: var(--ssh-layer-2);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.045);
  color: var(--ssh-text);
  outline: none;
  transition: border-color 130ms ease, box-shadow 130ms ease, background 130ms ease;
}
.dsh-ssh-helper-input:hover,
.dsh-ssh-helper-textarea:hover,
.dsh-ssh-helper-select:hover { border-color: color-mix(in srgb, var(--ssh-text) 34%, transparent); }
.dsh-ssh-helper-input::placeholder,
.dsh-ssh-helper-textarea::placeholder { color: var(--ssh-text-3); }
.dsh-ssh-helper-input,
.dsh-ssh-helper-select { height: 34px; padding: 0 10px; }
.dsh-ssh-helper-textarea { padding: 8px 10px; min-height: 82px; resize: vertical; font-family: var(--ssh-mono); font-size: 11.5px; line-height: 1.5; }
.dsh-ssh-helper-input:focus,
.dsh-ssh-helper-textarea:focus,
.dsh-ssh-helper-select:focus { border-color: color-mix(in srgb, var(--ssh-accent) 55%, var(--ssh-border)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ssh-accent) 14%, transparent); }
.dsh-ssh-helper-input.is-invalid,
.dsh-ssh-helper-textarea.is-invalid,
.dsh-ssh-helper-select.is-invalid { border-color: color-mix(in srgb, var(--ssh-error) 55%, var(--ssh-border)); }
.dsh-ssh-helper-auth-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.dsh-ssh-helper-auth-option {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border: 1px solid var(--ssh-border);
  border-radius: 7px;
  background: var(--ssh-layer-1);
  color: var(--ssh-text-2);
  font-size: 12px;
  text-align: left;
}
.dsh-ssh-helper-auth-option:hover { background: var(--ssh-hover); }
.dsh-ssh-helper-auth-option[aria-pressed="true"] { border-color: color-mix(in srgb, var(--ssh-accent) 45%, transparent); background: color-mix(in srgb, var(--ssh-accent) 8%, transparent); color: var(--ssh-text); }
.dsh-ssh-helper-auth-option svg { color: var(--ssh-accent); }
.dsh-ssh-helper-toggle { display: flex; align-items: flex-start; gap: 9px; padding: 8px 9px; border: 1px solid var(--ssh-border); border-radius: 8px; background: var(--ssh-layer-1); }
.dsh-ssh-helper-toggle input { position: absolute; opacity: 0; pointer-events: none; }
.dsh-ssh-helper-toggle-track { position: relative; width: 30px; height: 18px; flex: none; margin-top: 1px; border-radius: 999px; background: var(--ssh-layer-3); transition: background 140ms ease; }
.dsh-ssh-helper-toggle-track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--ssh-layer-1); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform 140ms ease; }
.dsh-ssh-helper-toggle input:checked + .dsh-ssh-helper-toggle-track { background: var(--ssh-accent); }
.dsh-ssh-helper-toggle input:checked + .dsh-ssh-helper-toggle-track::after { transform: translateX(12px); }
.dsh-ssh-helper-toggle input:focus-visible + .dsh-ssh-helper-toggle-track { outline: 2px solid var(--ssh-accent); outline-offset: 2px; }
.dsh-ssh-helper-toggle-copy { display: flex; flex-direction: column; gap: 1px; }
.dsh-ssh-helper-toggle-copy strong { font-size: 11.5px; font-weight: 620; }
.dsh-ssh-helper-toggle-copy span { color: var(--ssh-text-3); font-size: 10.5px; }
.dsh-ssh-helper-advanced-toggle { display: flex; align-items: center; gap: 6px; align-self: flex-start; padding: 0; border: 0; background: transparent; color: var(--ssh-accent); font-size: 11.5px; font-weight: 620; }
.dsh-ssh-helper-advanced-toggle svg { transition: transform 140ms ease; }
.dsh-ssh-helper-advanced-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
.dsh-ssh-helper-advanced { display: flex; flex-direction: column; gap: 12px; padding: 10px; border: 1px dashed var(--ssh-border-2); border-radius: 9px; }
.dsh-ssh-helper-form-footer { position: sticky; bottom: -24px; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; padding: 10px 0 4px; border-top: 1px solid var(--ssh-border); background-color: var(--dsw-alias-bg-base, #ffffff); background-image: linear-gradient(var(--ssh-layer-1), var(--ssh-layer-1)); box-shadow: 0 -10px 18px -16px rgba(0, 0, 0, 0.28); }
.dsh-ssh-helper-form-footer-right { display: flex; gap: 6px; }
.dsh-ssh-helper-test-result { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border: 1px solid var(--ssh-border); border-radius: 8px; background: var(--ssh-layer-2); font-size: 11.5px; }
.dsh-ssh-helper-test-result.is-ok { border-color: color-mix(in srgb, var(--ssh-success) 30%, transparent); background: color-mix(in srgb, var(--ssh-success) 7%, transparent); }
.dsh-ssh-helper-test-result.is-fail { border-color: color-mix(in srgb, var(--ssh-error) 30%, transparent); background: color-mix(in srgb, var(--ssh-error) 7%, transparent); }
.dsh-ssh-helper-test-result-head { display: flex; align-items: center; gap: 6px; font-weight: 620; }
.dsh-ssh-helper-test-result pre { margin: 0; max-height: 100px; overflow: auto; font-family: var(--ssh-mono); font-size: 10.5px; white-space: pre-wrap; word-break: break-word; }
.dsh-ssh-helper-confirm { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid color-mix(in srgb, var(--ssh-error) 30%, transparent); border-radius: 9px; background: color-mix(in srgb, var(--ssh-error) 6%, transparent); }
.dsh-ssh-helper-confirm strong { color: var(--ssh-error); font-size: 12px; }
.dsh-ssh-helper-confirm p { margin: 0; color: var(--ssh-text-2); font-size: 11px; }
.dsh-ssh-helper-confirm-actions { display: flex; gap: 6px; justify-content: flex-end; }
.dsh-ssh-helper-timeline { display: flex; flex-direction: column; gap: 4px; }
.dsh-ssh-helper-day { margin: 8px 0 2px; color: var(--ssh-text-3); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.dsh-ssh-helper-day:first-child { margin-top: 0; }
.dsh-ssh-helper-activity { display: grid; grid-template-columns: 48px 16px minmax(0, 1fr); gap: 7px; align-items: start; }
.dsh-ssh-helper-activity-time { padding-top: 10px; color: var(--ssh-text-3); font-size: 10.5px; text-align: right; font-family: var(--ssh-mono); }
.dsh-ssh-helper-activity-axis { display: flex; flex-direction: column; align-items: center; padding-top: 13px; }
.dsh-ssh-helper-activity-axis::after { content: ""; flex: 1; width: 1px; margin-top: 5px; background: var(--ssh-border); min-height: 12px; }
.dsh-ssh-helper-activity:last-child .dsh-ssh-helper-activity-axis::after { display: none; }
.dsh-ssh-helper-activity-card { margin: 3px 0; border: 1px solid var(--ssh-border); border-radius: 9px; background: var(--ssh-layer-1); overflow: hidden; }
.dsh-ssh-helper-activity-summary { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border: 0; background: transparent; color: inherit; text-align: left; }
.dsh-ssh-helper-activity-summary:hover { background: var(--ssh-hover); }
.dsh-ssh-helper-activity-summary-main { min-width: 0; flex: 1; }
.dsh-ssh-helper-activity-summary-title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 620; }
.dsh-ssh-helper-activity-summary-sub { margin-top: 1px; color: var(--ssh-text-2); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ssh-helper-activity-body { padding: 0 10px 10px; border-top: 1px solid var(--ssh-border); }
.dsh-ssh-helper-activity-message { margin: 8px 0 0; padding: 7px 9px; border-radius: 7px; background: var(--ssh-layer-2); color: var(--ssh-text-2); font-size: 11px; }
.dsh-ssh-helper-step { display: grid; grid-template-columns: 8px minmax(0, 1fr); gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--ssh-border); }
.dsh-ssh-helper-step:last-child { border-bottom: 0; }
.dsh-ssh-helper-step-dot { margin-top: 6px; }
.dsh-ssh-helper-step-title { font-size: 11.5px; font-weight: 600; }
.dsh-ssh-helper-step-meta { display: flex; gap: 8px; margin-top: 1px; color: var(--ssh-text-3); font-size: 10px; }
.dsh-ssh-helper-toasts { position: fixed; right: 18px; bottom: 18px; z-index: 1100; display: flex; flex-direction: column; gap: 7px; pointer-events: none; }
.dsh-ssh-helper-toast {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 220px;
  max-width: 360px;
  padding: 9px 10px;
  border: 1px solid var(--ssh-border);
  border-radius: 9px;
  background: var(--ssh-layer-1);
  box-shadow: 0 14px 40px -18px rgba(0, 0, 0, 0.4);
  color: var(--ssh-text);
  font-size: 11.5px;
  pointer-events: auto;
  animation: dsh-ssh-helper-toast-in 180ms ease;
}
.dsh-ssh-helper-toast.is-success svg { color: var(--ssh-success); }
.dsh-ssh-helper-toast.is-error svg { color: var(--ssh-error); }
.dsh-ssh-helper-toast-close { margin-left: auto; }
.dsh-ssh-helper-loading-panel { display: flex; flex-direction: column; gap: 12px; padding: 24px; border: 1px solid var(--ssh-border); border-radius: var(--ssh-radius); background: var(--ssh-layer-1); }
.dsh-ssh-helper-loading-panel p { margin: 0; color: var(--ssh-text-2); font-size: 12px; }
.dsh-ssh-helper-error-panel { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 42px 20px; border: 1px solid color-mix(in srgb, var(--ssh-error) 25%, transparent); border-radius: var(--ssh-radius); background: color-mix(in srgb, var(--ssh-error) 5%, transparent); text-align: center; }
.dsh-ssh-helper-error-panel h4 { margin: 0; font-size: 14px; }
.dsh-ssh-helper-error-panel p { margin: 0; max-width: 44ch; color: var(--ssh-text-2); font-size: 12px; }
@keyframes dsh-ssh-helper-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes dsh-ssh-helper-slide-in { from { transform: translateX(26px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes dsh-ssh-helper-toast-in { from { transform: translateY(7px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes dsh-ssh-helper-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }
@keyframes dsh-ssh-helper-spin { to { transform: rotate(360deg); } }
@keyframes dsh-ssh-helper-pulse { 0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent); } 50% { box-shadow: 0 0 0 5px color-mix(in srgb, currentColor 6%, transparent); } }
@media (max-width: 760px) {
  .dsh-ssh-helper-page { padding: calc(16px + var(--dsh-frame-top-clearance, 0px)) 14px 28px; }
  .dsh-ssh-helper-hero { flex-direction: column; }
  .dsh-ssh-helper-stats { width: 100%; }
  .dsh-ssh-helper-stat { flex: 1; min-width: 0; }
  .dsh-ssh-helper-console { grid-template-columns: 1fr; }
  .dsh-ssh-helper-rail { position: static; flex-direction: row; overflow-x: auto; }
  .dsh-ssh-helper-rail-item { width: auto; flex: 1; justify-content: center; }
  .dsh-ssh-helper-rail-count { display: none; }
  .dsh-ssh-helper-rail-note { display: none; }
  .dsh-ssh-helper-view-head { align-items: flex-start; flex-direction: column; }
  .dsh-ssh-helper-row-time { display: none; }
  .dsh-ssh-helper-row-actions { opacity: 1; }
}
@media (max-width: 520px) {
  .dsh-ssh-helper-sheet { width: 100vw; }
  .dsh-ssh-helper-activity { grid-template-columns: 0 16px minmax(0, 1fr); }
  .dsh-ssh-helper-activity-time { display: none; }
  .dsh-ssh-helper-auth-row { grid-template-columns: 1fr; }
  .dsh-ssh-helper-grid-2 { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-ssh-helper-section *,
  .dsh-ssh-helper-section *::before,
  .dsh-ssh-helper-section *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
}
`

    function installStyles() {
      const previous = document.getElementById(STYLE_ID)
      if (previous !== null && previous.parentNode !== null) previous.parentNode.removeChild(previous)
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        if (style.parentNode !== null) style.parentNode.removeChild(style)
      }
    }

    // ---------------------------------------------------------------------
    // Primitives
    // ---------------------------------------------------------------------

    function Button(props) {
      const variant = props.variant === undefined ? 'secondary' : props.variant
      const size = props.size === undefined ? 'md' : props.size
      return h('button', {
        type: props.type === undefined ? 'button' : props.type,
        className: cls('dsh-ssh-helper-btn', `dsh-ssh-helper-btn--${variant}`, size === 'sm' && 'dsh-ssh-helper-btn--sm', props.className),
        onClick: props.onClick,
        disabled: props.disabled === true || props.loading === true,
        title: props.title,
        'aria-label': props.ariaLabel,
        'aria-expanded': props.ariaExpanded,
        form: props.form,
      },
      props.loading === true ? h('span', { className: 'dsh-ssh-helper-spinner' }) : null,
      props.icon === undefined ? null : h(Icon, { name: props.icon, size: 14 }),
      props.children === undefined ? null : h('span', null, props.children))
    }

    function IconButton(props) {
      return h('button', {
        type: 'button',
        className: cls('dsh-ssh-helper-btn', 'dsh-ssh-helper-btn--icon', props.className),
        onClick: props.onClick,
        disabled: props.disabled === true,
        title: props.label,
        'aria-label': props.label,
      }, h(Icon, { name: props.icon, size: props.size === undefined ? 15 : props.size }))
    }

    function SearchBox(props) {
      return h('div', { className: 'dsh-ssh-helper-search' },
        h(Icon, { name: 'search', size: 14 }),
        h('input', {
          type: 'search',
          value: props.value,
          placeholder: props.placeholder,
          onChange: (event) => props.onChange(event.target.value),
          'aria-label': props.placeholder,
          spellCheck: false,
        }))
    }

    function Chip(props) {
      return h('span', { className: cls('dsh-ssh-helper-chip', props.tone === undefined ? undefined : `dsh-ssh-helper-chip--${props.tone}`) }, props.children)
    }

    function StatusChip(props) {
      const meta = statusMeta(props.status)
      return h(Chip, { tone: meta.tone }, h('span', { className: cls('dsh-ssh-helper-dot', `dsh-ssh-helper-dot--${meta.tone}`) }), props.t(props.key))
    }

    function StatusDot(props) {
      return h('span', { className: cls('dsh-ssh-helper-dot', `dsh-ssh-helper-dot--${props.tone || 'idle'}`, props.pulse === true && 'dsh-ssh-helper-dot--pulse') })
    }

    function Field(props) {
      return h('div', { className: cls('dsh-ssh-helper-field', props.className) },
        h('label', { htmlFor: props.htmlFor }, props.label, props.required === true ? h('span', { className: 'dsh-ssh-helper-required' }, ' *') : null),
        props.children,
        props.hint === undefined ? null : h('span', { className: 'dsh-ssh-helper-field-hint' }, props.hint),
        props.error === undefined ? null : h('span', { className: 'dsh-ssh-helper-field-error', role: 'alert' }, props.error))
    }

    function TextInput(props) {
      return h('input', {
        id: props.id,
        type: props.type === undefined ? 'text' : props.type,
        value: props.value,
        placeholder: props.placeholder,
        autoComplete: props.autoComplete,
        className: cls('dsh-ssh-helper-input', props.invalid === true && 'is-invalid'),
        onChange: (event) => props.onChange(event.target.value),
        onKeyDown: props.onKeyDown,
        spellCheck: false,
        ref: props.inputRef,
      })
    }

    function TextArea(props) {
      return h('textarea', {
        id: props.id,
        value: props.value,
        rows: props.rows === undefined ? 4 : props.rows,
        placeholder: props.placeholder,
        className: cls('dsh-ssh-helper-textarea', props.invalid === true && 'is-invalid'),
        onChange: (event) => props.onChange(event.target.value),
        spellCheck: false,
        ref: props.inputRef,
      })
    }

    function Select(props) {
      return h('select', {
        id: props.id,
        value: props.value,
        className: cls('dsh-ssh-helper-select', props.invalid === true && 'is-invalid'),
        onChange: (event) => props.onChange(event.target.value),
      }, props.children)
    }

    function Toggle(props) {
      return h('label', { className: 'dsh-ssh-helper-toggle' },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', { className: 'dsh-ssh-helper-toggle-track', 'aria-hidden': 'true' }),
        h('span', { className: 'dsh-ssh-helper-toggle-copy' },
          h('strong', null, props.label),
          props.description === undefined ? null : h('span', null, props.description)))
    }

    function SectionLabel(props) {
      return h('div', { className: 'dsh-ssh-helper-section-label' }, props.icon === undefined ? null : h(Icon, { name: props.icon, size: 12 }), props.children)
    }

    function MetaRow(props) {
      return h('div', { className: 'dsh-ssh-helper-meta-row' },
        h('div', { className: 'dsh-ssh-helper-meta-label' }, props.label),
        h('div', { className: 'dsh-ssh-helper-meta-value' },
          props.children,
          props.onCopy === undefined ? null : h(IconButton, { icon: 'copy', label: props.copyLabel || 'Copy', size: 13, onClick: props.onCopy })))
    }

    function MetaGrid(props) {
      return h('div', { className: 'dsh-ssh-helper-meta' }, props.children)
    }

    function CodeBlock(props) {
      const [expanded, setExpanded] = useState(false)
      const value = text(props.value)
      if (value === '') return null
      const long = value.length > 420 || value.split('\n').length > 7
      return h('div', { className: cls('dsh-ssh-helper-code', expanded && 'is-expanded') },
        h('div', { className: 'dsh-ssh-helper-code-head' },
          h('span', null, props.label),
          h('div', { className: 'dsh-ssh-helper-code-head-actions' },
            long ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => setExpanded(!expanded) }, expanded ? props.t('showLess') : props.t('showMore')) : null,
            h(IconButton, { icon: 'copy', label: props.t('copyCommand'), size: 13, onClick: () => props.onCopy(value) }))),
        h('pre', null, value))
    }

    function TestResult(props) {
      const result = props.result
      if (!result) return null
      const ok = result.status === 'ok'
      const toneClass = ok ? 'is-ok' : (result.status === 'testing' ? '' : 'is-fail')
      return h('div', { className: cls('dsh-ssh-helper-test-result', toneClass) },
        h('div', { className: 'dsh-ssh-helper-test-result-head' },
          result.status === 'testing' ? h('span', { className: 'dsh-ssh-helper-spinner' }) : h(StatusDot, { tone: ok ? 'success' : 'error' }),
          h('span', null, result.status === 'testing' ? props.t('testing') : (ok ? props.t('testOk') : props.t('testFail'))),
          ok && typeof result.latencyMs === 'number' ? h('span', { className: 'dsh-ssh-helper-muted' }, `${result.latencyMs} ms`) : null,
          !ok && typeof result.message === 'string' && result.message !== '' ? h('span', { className: 'dsh-ssh-helper-muted' }, `· ${result.message}`) : null),
        ok && typeof result.output === 'string' && result.output !== '' ? h('pre', null, result.output) : null)
    }

    function EmptyState(props) {
      return h('div', { className: 'dsh-ssh-helper-empty' },
        h('div', { className: 'dsh-ssh-helper-empty-mark' }, h(Icon, { name: props.icon || 'terminal', size: 20 })),
        h('h4', null, props.title),
        h('p', null, props.description),
        props.actions === undefined ? null : h('div', { className: 'dsh-ssh-helper-empty-actions' }, props.actions))
    }

    function SkeletonList(props) {
      const rows = props.rows === undefined ? 4 : props.rows
      return h('div', { className: 'dsh-ssh-helper-skeleton', 'aria-hidden': 'true' },
        Array.from({ length: rows }, (_, index) => h('div', { key: index, className: 'dsh-ssh-helper-skeleton-row' },
          h('div', { className: 'dsh-ssh-helper-skeleton-block dsh-ssh-helper-skeleton-avatar' }),
          h('div', { className: 'dsh-ssh-helper-skeleton-lines' },
            h('div', { className: 'dsh-ssh-helper-skeleton-block dsh-ssh-helper-skeleton-line' }),
            h('div', { className: 'dsh-ssh-helper-skeleton-block dsh-ssh-helper-skeleton-line is-short' })))))
    }

    function ToastStack(props) {
      return h('div', { className: 'dsh-ssh-helper-toasts', 'aria-live': 'polite' },
        props.toasts.map((toast) => h('div', { key: toast.id, className: cls('dsh-ssh-helper-toast', toast.tone === 'error' ? 'is-error' : 'is-success') },
          h(Icon, { name: toast.tone === 'error' ? 'alert' : 'check', size: 15 }),
          h('span', null, toast.message),
          h(IconButton, { icon: 'x', label: 'Dismiss', size: 13, className: 'dsh-ssh-helper-toast-close', onClick: () => props.onDismiss(toast.id) }))))
    }

    function ConfirmInline(props) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      async function confirm() {
        setBusy(true)
        setError('')
        try {
          await props.onConfirm()
        } catch (caught) {
          setError(errorMessage(caught, props.t('toastDeleteFailed')))
          setBusy(false)
        }
      }
      return h('div', { className: 'dsh-ssh-helper-confirm' },
        h('strong', null, props.title),
        h('p', null, props.description),
        error === '' ? null : h('span', { className: 'dsh-ssh-helper-field-error' }, error),
        h('div', { className: 'dsh-ssh-helper-confirm-actions' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: props.onCancel, disabled: busy }, props.t('cancel')),
          h(Button, { variant: 'danger', size: 'sm', loading: busy, onClick: confirm }, props.t('confirmDelete'))))
    }

    function Sheet(props) {
      const panelRef = useRef(null)
      const closeRef = useRef(props.onClose)
      closeRef.current = props.onClose
      const titleId = useRef(`dsh-ssh-helper-sheet-${Math.random().toString(36).slice(2)}`).current
      const previousFocus = useRef(null)
      useEffect(() => {
        previousFocus.current = document.activeElement
        const body = document.body
        const previousOverflow = body.style.overflow
        const previousPadding = body.style.paddingRight
        const scrollbar = Math.max(0, window.innerWidth - document.documentElement.clientWidth)
        body.style.overflow = 'hidden'
        if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`
        const panel = panelRef.current
        const firstInput = panel === null ? null : panel.querySelector('input, textarea, select')
        const firstControl = firstInput !== null ? firstInput : (panel === null ? null : panel.querySelector('button, [href], [tabindex]:not([tabindex="-1"])'))
        if (firstControl !== null) firstControl.focus()
        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            closeRef.current()
            return
          }
          if (event.key !== 'Tab' || panel === null) return
          const focusable = Array.from(panel.querySelectorAll('input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])'))
            .filter((element) => element.disabled !== true && element.getAttribute('aria-hidden') !== 'true' && element.offsetParent !== null)
          if (focusable.length === 0) return
          const firstElement = focusable[0]
          const lastElement = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === firstElement) {
            event.preventDefault()
            lastElement.focus()
          } else if (!event.shiftKey && document.activeElement === lastElement) {
            event.preventDefault()
            firstElement.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          body.style.overflow = previousOverflow
          body.style.paddingRight = previousPadding
          if (previousFocus.current !== null && typeof previousFocus.current.focus === 'function') previousFocus.current.focus()
        }
      }, [])
      return h('div', { className: 'dsh-ssh-helper-sheet-root', role: 'presentation' },
        h('div', { className: 'dsh-ssh-helper-scrim', onClick: props.onClose, 'aria-hidden': 'true' }),
        h('section', {
          className: cls('dsh-ssh-helper-sheet', props.wide === true && 'is-wide'),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          ref: panelRef,
        },
        h('header', { className: 'dsh-ssh-helper-sheet-head' },
          h('div', null,
            h('h2', { id: titleId }, props.title),
            props.subtitle === undefined ? null : h('p', { title: props.subtitle }, props.subtitle)),
          h(IconButton, { icon: 'x', label: props.t('close'), onClick: props.onClose })),
        h('div', { className: 'dsh-ssh-helper-sheet-body' }, props.children)))
    }

    // ---------------------------------------------------------------------
    // Account draft, form and detail
    // ---------------------------------------------------------------------

    function emptyAccountDraft() {
      return {
        id: undefined,
        name: '',
        host: '',
        port: '22',
        username: '',
        authType: 'password',
        password: '',
        privateKey: '',
        passphrase: '',
        note: '',
      }
    }

    function accountDraftFrom(account) {
      if (!account) return emptyAccountDraft()
      return {
        id: account.id,
        name: account.name || '',
        host: account.host || '',
        port: String(account.port === undefined ? 22 : account.port),
        username: account.username || '',
        authType: account.authType === 'key' ? 'key' : 'password',
        password: '',
        privateKey: '',
        passphrase: '',
        note: account.note || '',
      }
    }

    function accountPayload(draft) {
      const payload = {
        name: draft.name.trim(),
        host: draft.host.trim(),
        port: Number(draft.port),
        username: draft.username.trim(),
        authType: draft.authType,
        note: draft.note.trim(),
      }
      if (draft.id !== undefined && draft.id !== null && draft.id !== '') payload.id = draft.id
      if (draft.authType === 'password') {
        if (draft.password !== '') payload.password = draft.password
      } else {
        if (draft.privateKey.trim() !== '') payload.privateKey = draft.privateKey
        if (draft.passphrase !== '') payload.passphrase = draft.passphrase
      }
      return payload
    }

    function validateAccountDraft(t, draft, account) {
      const errors = {}
      if (draft.host.trim() === '') errors.host = t('validationHost')
      const port = Number(draft.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = t('validationPort')
      if (draft.username.trim() === '') errors.username = t('validationUsername')
      if (draft.authType === 'password') {
        const keeps = account !== null && account !== undefined && account.authType === 'password' && account.hasPassword === true
        if (draft.password === '' && !keeps) errors.password = t('validationPassword')
      } else {
        const keeps = account !== null && account !== undefined && account.authType === 'key' && account.hasKey === true
        if (draft.privateKey.trim() === '' && !keeps) errors.privateKey = t('validationKey')
      }
      return errors
    }

    function AccountForm(props) {
      const { t, account, onSaved } = props
      const [draft, setDraft] = useState(accountDraftFrom(account))
      const [errors, setErrors] = useState({})
      const [saving, setSaving] = useState(false)
      const [testing, setTesting] = useState(false)
      const [testResult, setTestResult] = useState(null)
      const [formError, setFormError] = useState('')
      const firstRef = useRef(null)
      useEffect(() => {
        if (firstRef.current !== null) firstRef.current.focus()
      }, [])
      function patch(key, value) {
        setDraft((previous) => ({ ...previous, [key]: value }))
        setErrors((previous) => {
          if (previous[key] === undefined) return previous
          const next = { ...previous }
          delete next[key]
          return next
        })
      }
      async function submit(event) {
        event.preventDefault()
        const nextErrors = validateAccountDraft(t, draft, account)
        if (Object.keys(nextErrors).length > 0) {
          setErrors(nextErrors)
          const order = ['host', 'port', 'username', 'password', 'privateKey']
          const firstKey = order.find((key) => nextErrors[key] !== undefined)
          const element = firstKey === undefined ? null : document.getElementById(`ssh-helper-account-${firstKey}`)
          if (element !== null) element.focus()
          return
        }
        setSaving(true)
        setFormError('')
        try {
          const data = await call('accounts/save', accountPayload(draft))
          await onSaved(data.account)
        } catch (caught) {
          setFormError(errorMessage(caught, t('toastSaveFailed')))
          setSaving(false)
        }
      }
      async function testDraft() {
        const nextErrors = validateAccountDraft(t, draft, account)
        if (Object.keys(nextErrors).length > 0) {
          setErrors(nextErrors)
          return
        }
        setTesting(true)
        setTestResult(null)
        setFormError('')
        try {
          const data = await call('accounts/test-draft', accountPayload(draft))
          setTestResult({
            status: data.success === true ? 'ok' : 'fail',
            latencyMs: data.latencyMs,
            message: data.message,
            output: data.output,
          })
        } catch (caught) {
          setTestResult({ status: 'fail', message: errorMessage(caught, t('testFail')) })
        } finally {
          setTesting(false)
        }
      }
      const auth = draft.authType
      return h('form', { className: 'dsh-ssh-helper-form', onSubmit: submit },
        h('p', { className: 'dsh-ssh-helper-form-hint' }, t('formHintAccount')),
        h(Field, { label: t('fieldName'), htmlFor: 'ssh-helper-account-name', hint: t('fieldNameHint'), error: errors.name },
          h(TextInput, { id: 'ssh-helper-account-name', value: draft.name, onChange: (value) => patch('name', value), inputRef: firstRef })),
        h('div', { className: 'dsh-ssh-helper-grid-2' },
          h(Field, { label: t('fieldHost'), htmlFor: 'ssh-helper-account-host', required: true, error: errors.host },
            h(TextInput, { id: 'ssh-helper-account-host', value: draft.host, onChange: (value) => patch('host', value), invalid: errors.host !== undefined, placeholder: '10.0.0.10' })),
          h(Field, { label: t('fieldPort'), htmlFor: 'ssh-helper-account-port', required: true, error: errors.port },
            h(TextInput, { id: 'ssh-helper-account-port', value: draft.port, onChange: (value) => patch('port', value), invalid: errors.port !== undefined, type: 'number' }))),
        h(Field, { label: t('fieldUsername'), htmlFor: 'ssh-helper-account-username', required: true, error: errors.username },
          h(TextInput, { id: 'ssh-helper-account-username', value: draft.username, onChange: (value) => patch('username', value), invalid: errors.username !== undefined, placeholder: 'root' })),
        h(Field, { label: t('fieldAuthType') },
          h('div', { className: 'dsh-ssh-helper-auth-row' },
            h('button', { type: 'button', className: 'dsh-ssh-helper-auth-option', 'aria-pressed': auth === 'password' ? 'true' : 'false', onClick: () => patch('authType', 'password') },
              h(Icon, { name: 'key', size: 14 }), t('authPassword')),
            h('button', { type: 'button', className: 'dsh-ssh-helper-auth-option', 'aria-pressed': auth === 'key' ? 'true' : 'false', onClick: () => patch('authType', 'key') },
              h(Icon, { name: 'lock', size: 14 }), t('authKey')))),
        auth === 'password'
          ? h(Field, { label: t('fieldPassword'), htmlFor: 'ssh-helper-account-password', required: true, error: errors.password, hint: account && account.hasPassword ? t('secretKeepHint') : t('secretRequiredHint') },
            h(TextInput, { id: 'ssh-helper-account-password', value: draft.password, onChange: (value) => patch('password', value), invalid: errors.password !== undefined, type: 'password', autoComplete: 'new-password' }))
          : h('div', null,
            h(Field, { label: t('fieldPrivateKey'), htmlFor: 'ssh-helper-account-privateKey', required: true, error: errors.privateKey, hint: account && account.hasKey ? t('secretKeepHint') : t('secretRequiredHint') },
              h(TextArea, { id: 'ssh-helper-account-privateKey', value: draft.privateKey, onChange: (value) => patch('privateKey', value), invalid: errors.privateKey !== undefined, rows: 5, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' })),
            h(Field, { label: t('fieldPassphrase'), htmlFor: 'ssh-helper-account-passphrase', hint: account && account.hasKey ? t('secretKeepHint') : undefined },
              h(TextInput, { id: 'ssh-helper-account-passphrase', value: draft.passphrase, onChange: (value) => patch('passphrase', value), type: 'password', autoComplete: 'new-password' }))),
        h(Field, { label: t('fieldNote'), htmlFor: 'ssh-helper-account-note' },
          h(TextArea, { id: 'ssh-helper-account-note', value: draft.note, onChange: (value) => patch('note', value), rows: 2 })),
        formError === '' ? null : h('div', { className: 'dsh-ssh-helper-error-banner', role: 'alert' }, h(Icon, { name: 'alert', size: 14 }), formError),
        testResult === null ? null : h(TestResult, { t, result: testResult }),
        h('div', { className: 'dsh-ssh-helper-form-footer' },
          h(Button, { variant: 'ghost', loading: testing, onClick: testDraft, disabled: saving }, t('testDraft')),
          h('div', { className: 'dsh-ssh-helper-form-footer-right' },
            h(Button, { variant: 'ghost', onClick: props.onClose, disabled: saving }, t('cancel')),
            h(Button, { variant: 'primary', type: 'submit', loading: saving }, saving ? t('saving') : t('save')))))
    }

    function AccountDetail(props) {
      const { t, account, testResult, onTest, onEdit, onDelete, onCopy, onClose } = props
      const [confirming, setConfirming] = useState(false)
      const initials = (account.name || account.username || '?').trim().slice(0, 2).toUpperCase()
      return h('div', { className: 'dsh-ssh-helper-detail' },
        h('div', { className: 'dsh-ssh-helper-detail-summary' },
          h('div', { className: 'dsh-ssh-helper-avatar' }, initials),
          h('div', { className: 'dsh-ssh-helper-detail-title' },
            h('h3', null, account.name),
            h('p', { className: 'dsh-ssh-helper-mono' }, `${account.username}@${account.host}:${account.port}`)),
          h(StatusDot, { tone: testResult !== null && testResult !== undefined ? (testResult.status === 'ok' ? 'success' : 'error') : 'idle' })),
        h('div', { className: 'dsh-ssh-helper-detail-actions' },
          h(Button, { variant: 'secondary', icon: 'play', loading: testResult !== null && testResult !== undefined && testResult.status === 'testing', onClick: () => onTest(account) }, t('test')),
          h(Button, { variant: 'secondary', icon: 'edit', onClick: () => onEdit(account) }, t('edit')),
          h(Button, { variant: 'ghost', icon: 'copy', onClick: () => onCopy(sshCommand(account)) }, t('copySsh')),
          h(Button, { variant: 'danger', icon: 'trash', onClick: () => setConfirming(true) }, t('delete'))),
        confirming
          ? h(ConfirmInline, {
            t,
            title: t('deleteServerTitle'),
            description: t('deleteServerDesc'),
            onCancel: () => setConfirming(false),
            onConfirm: async () => { await onDelete(account) },
          })
          : null,
        h(TestResult, { t, result: testResult }),
        h(SectionLabel, { icon: 'server' }, t('sectionConnection')),
        h(MetaGrid, null,
          h(MetaRow, { label: t('fieldHost'), onCopy: () => onCopy(account.host), copyLabel: t('copy') }, h('span', { className: 'dsh-ssh-helper-mono' }, account.host)),
          h(MetaRow, { label: t('fieldPort') }, h('span', { className: 'dsh-ssh-helper-mono' }, String(account.port))),
          h(MetaRow, { label: t('fieldUsername') }, h('span', { className: 'dsh-ssh-helper-mono' }, account.username)),
          h(MetaRow, { label: t('fieldAuthType') },
            h(Chip, { tone: 'neutral' }, account.authType === 'key' ? t('authKey') : t('authPassword')),
            h(Chip, { tone: account.hasPassword || account.hasKey ? 'success' : 'idle' }, credentialLabel(t, account))),
          h(MetaRow, { label: t('updatedAt') }, h('span', { className: 'dsh-ssh-helper-muted' }, formatDateTime(account.updatedAt)))),
        account.note === undefined || account.note === '' ? null : h('div', null,
          h(SectionLabel, { icon: 'edit' }, t('sectionNote')),
          h('p', { className: 'dsh-ssh-helper-form-hint' }, account.note)))
    }

    // ---------------------------------------------------------------------
    // Resource draft, form and detail
    // ---------------------------------------------------------------------

    function emptyResourceDraft(accounts) {
      return {
        id: undefined,
        name: '',
        server: accounts.length > 0 ? accounts[0].id : '',
        serviceName: '',
        appDir: '',
        updateCommand: '',
        restartCommand: '',
        verifyCommand: '',
        backupEnabled: true,
        backupDir: '',
        backupKeep: '5',
        timeoutSeconds: '600',
        note: '',
        tagsText: '',
      }
    }

    function resourceDraftFrom(resource, accounts) {
      if (!resource) return emptyResourceDraft(accounts)
      return {
        id: resource.id,
        name: resource.name || '',
        server: resource.serverId || (accounts.length > 0 ? accounts[0].id : ''),
        serviceName: resource.serviceName || '',
        appDir: resource.appDir || '',
        updateCommand: resource.updateCommand || '',
        restartCommand: resource.restartCommand || '',
        verifyCommand: resource.verifyCommand || '',
        backupEnabled: resource.backupEnabled !== false,
        backupDir: resource.backupDir || '',
        backupKeep: String(resource.backupKeep === undefined ? 5 : resource.backupKeep),
        timeoutSeconds: String(resource.timeoutSeconds === undefined ? 600 : resource.timeoutSeconds),
        note: resource.note || '',
        tagsText: Array.isArray(resource.tags) ? resource.tags.join(', ') : '',
      }
    }

    function resourcePayload(draft) {
      const tags = draft.tagsText.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '')
      const payload = {
        name: draft.name.trim(),
        server: draft.server,
        serviceName: draft.serviceName.trim(),
        appDir: draft.appDir.trim(),
        updateCommand: draft.updateCommand,
        restartCommand: draft.restartCommand,
        verifyCommand: draft.verifyCommand,
        backupEnabled: draft.backupEnabled,
        backupDir: draft.backupDir.trim(),
        backupKeep: Number(draft.backupKeep),
        timeoutSeconds: Number(draft.timeoutSeconds),
        note: draft.note.trim(),
        tags,
      }
      if (draft.id !== undefined && draft.id !== null && draft.id !== '') payload.id = draft.id
      return payload
    }

    function validateResourceDraft(t, draft) {
      const errors = {}
      if (draft.name.trim() === '') errors.name = t('validationName')
      if (draft.server === '') errors.server = t('validationServer')
      const appDir = draft.appDir.trim()
      if (appDir === '' || !appDir.startsWith('/')) errors.appDir = t('validationAppDir')
      if (draft.updateCommand.trim() === '') errors.updateCommand = t('validationUpdate')
      if (draft.backupDir.trim() !== '' && !draft.backupDir.trim().startsWith('/')) errors.backupDir = t('validationBackupDir')
      const keep = Number(draft.backupKeep)
      if (!Number.isInteger(keep) || keep < 1 || keep > 50) errors.backupKeep = t('validationBackupKeep')
      const timeout = Number(draft.timeoutSeconds)
      if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3600) errors.timeoutSeconds = t('validationTimeout')
      return errors
    }

    function ResourceForm(props) {
      const { t, resource, accounts, onSaved } = props
      const [draft, setDraft] = useState(resourceDraftFrom(resource, accounts))
      const [errors, setErrors] = useState({})
      const [saving, setSaving] = useState(false)
      const [formError, setFormError] = useState('')
      const [advanced, setAdvanced] = useState(
        resource !== null && resource !== undefined && (
          text(resource.restartCommand) !== '' ||
          text(resource.verifyCommand) !== '' ||
          text(resource.backupDir) !== '' ||
          (Array.isArray(resource.tags) && resource.tags.length > 0) ||
          text(resource.note) !== ''
        )
      )
      const firstRef = useRef(null)
      useEffect(() => {
        if (firstRef.current !== null) firstRef.current.focus()
      }, [])
      function patch(key, value) {
        setDraft((previous) => ({ ...previous, [key]: value }))
        setErrors((previous) => {
          if (previous[key] === undefined) return previous
          const next = { ...previous }
          delete next[key]
          return next
        })
      }
      async function submit(event) {
        event.preventDefault()
        const nextErrors = validateResourceDraft(t, draft)
        if (Object.keys(nextErrors).length > 0) {
          setErrors(nextErrors)
          const order = ['name', 'server', 'appDir', 'updateCommand', 'backupDir', 'backupKeep', 'timeoutSeconds']
          const firstKey = order.find((key) => nextErrors[key] !== undefined)
          const element = firstKey === undefined ? null : document.getElementById(`ssh-helper-resource-${firstKey}`)
          if (element !== null) element.focus()
          return
        }
        setSaving(true)
        setFormError('')
        try {
          const data = await call('resources/save', resourcePayload(draft))
          await onSaved(data.resource)
        } catch (caught) {
          setFormError(errorMessage(caught, t('toastSaveFailed')))
          setSaving(false)
        }
      }
      return h('form', { className: 'dsh-ssh-helper-form', onSubmit: submit },
        h('p', { className: 'dsh-ssh-helper-form-hint' }, t('formHintResource')),
        h(Field, { label: t('fieldName'), htmlFor: 'ssh-helper-resource-name', required: true, error: errors.name },
          h(TextInput, { id: 'ssh-helper-resource-name', value: draft.name, onChange: (value) => patch('name', value), invalid: errors.name !== undefined, inputRef: firstRef, placeholder: 'web-api' })),
        h(Field, { label: t('fieldServer'), htmlFor: 'ssh-helper-resource-server', required: true, error: errors.server },
          h(Select, { id: 'ssh-helper-resource-server', value: draft.server, onChange: (value) => patch('server', value), invalid: errors.server !== undefined },
            accounts.map((account) => h('option', { key: account.id, value: account.id }, `${account.name} — ${account.username}@${account.host}`)))),
        h(Field, { label: t('fieldAppDir'), htmlFor: 'ssh-helper-resource-appDir', required: true, error: errors.appDir },
          h(TextInput, { id: 'ssh-helper-resource-appDir', value: draft.appDir, onChange: (value) => patch('appDir', value), invalid: errors.appDir !== undefined, placeholder: '/opt/web-api' })),
        h(Field, { label: t('fieldUpdate'), htmlFor: 'ssh-helper-resource-updateCommand', required: true, error: errors.updateCommand },
          h(TextArea, { id: 'ssh-helper-resource-updateCommand', value: draft.updateCommand, onChange: (value) => patch('updateCommand', value), invalid: errors.updateCommand !== undefined, rows: 5, placeholder: 'git pull --ff-only' })),
        h('button', { type: 'button', className: 'dsh-ssh-helper-advanced-toggle', 'aria-expanded': advanced ? 'true' : 'false', onClick: () => setAdvanced(!advanced) },
          h(Icon, { name: 'chevronDown', size: 13 }), advanced ? t('showLess') : t('showMore')),
        advanced ? h('div', { className: 'dsh-ssh-helper-advanced' },
          h(Field, { label: t('fieldServiceName'), htmlFor: 'ssh-helper-resource-serviceName' },
            h(TextInput, { id: 'ssh-helper-resource-serviceName', value: draft.serviceName, onChange: (value) => patch('serviceName', value), placeholder: 'web-api' })),
          h(Field, { label: t('fieldRestart'), htmlFor: 'ssh-helper-resource-restartCommand' },
            h(TextArea, { id: 'ssh-helper-resource-restartCommand', value: draft.restartCommand, onChange: (value) => patch('restartCommand', value), rows: 2, placeholder: 'systemctl restart web-api' })),
          h(Field, { label: t('fieldVerify'), htmlFor: 'ssh-helper-resource-verifyCommand' },
            h(TextArea, { id: 'ssh-helper-resource-verifyCommand', value: draft.verifyCommand, onChange: (value) => patch('verifyCommand', value), rows: 2, placeholder: 'curl -fsS http://127.0.0.1:8080/health' })),
          h(Toggle, { checked: draft.backupEnabled, onChange: (value) => patch('backupEnabled', value), label: t('fieldBackupEnabled'), description: t('sectionBackup') }),
          draft.backupEnabled ? h('div', { className: 'dsh-ssh-helper-grid-2' },
            h(Field, { label: t('fieldBackupDir'), htmlFor: 'ssh-helper-resource-backupDir', error: errors.backupDir },
              h(TextInput, { id: 'ssh-helper-resource-backupDir', value: draft.backupDir, onChange: (value) => patch('backupDir', value), invalid: errors.backupDir !== undefined, placeholder: '/opt/.ssh-helper-backups' })),
            h(Field, { label: t('fieldBackupKeep'), htmlFor: 'ssh-helper-resource-backupKeep', error: errors.backupKeep },
              h(TextInput, { id: 'ssh-helper-resource-backupKeep', value: draft.backupKeep, onChange: (value) => patch('backupKeep', value), invalid: errors.backupKeep !== undefined, type: 'number' }))) : null,
          h(Field, { label: t('fieldTimeout'), htmlFor: 'ssh-helper-resource-timeoutSeconds', error: errors.timeoutSeconds },
            h(TextInput, { id: 'ssh-helper-resource-timeoutSeconds', value: draft.timeoutSeconds, onChange: (value) => patch('timeoutSeconds', value), invalid: errors.timeoutSeconds !== undefined, type: 'number' })),
          h(Field, { label: t('fieldTags'), htmlFor: 'ssh-helper-resource-tags', hint: t('tagsHint') },
            h(TextInput, { id: 'ssh-helper-resource-tags', value: draft.tagsText, onChange: (value) => patch('tagsText', value), placeholder: 'web, nginx' })),
          h(Field, { label: t('fieldNote'), htmlFor: 'ssh-helper-resource-note' },
            h(TextArea, { id: 'ssh-helper-resource-note', value: draft.note, onChange: (value) => patch('note', value), rows: 2 }))) : null,
        formError === '' ? null : h('div', { className: 'dsh-ssh-helper-error-banner', role: 'alert' }, h(Icon, { name: 'alert', size: 14 }), formError),
        h('div', { className: 'dsh-ssh-helper-form-footer' },
          h('span', null),
          h('div', { className: 'dsh-ssh-helper-form-footer-right' },
            h(Button, { variant: 'ghost', onClick: props.onClose, disabled: saving }, t('cancel')),
            h(Button, { variant: 'primary', type: 'submit', loading: saving }, saving ? t('saving') : t('save')))))
    }

    function ResourceDetail(props) {
      const { t, resource, activity, onEdit, onDelete, onCopy, onViewActivity } = props
      const [confirming, setConfirming] = useState(false)
      const meta = statusMeta(resource.lastUpdateStatus)
      const discovered = resource.discovered !== null && typeof resource.discovered === 'object' ? resource.discovered : null
      return h('div', { className: 'dsh-ssh-helper-detail' },
        h('div', { className: 'dsh-ssh-helper-detail-summary' },
          h(StatusDot, { tone: meta.tone }),
          h('div', { className: 'dsh-ssh-helper-detail-title' },
            h('h3', null, resource.name),
            h('p', { className: 'dsh-ssh-helper-mono' }, `${resource.serverName || t('unknownServer')} · ${resource.appDir}`)),
          h(StatusChip, { t, status: resource.lastUpdateStatus })),
        h('div', { className: 'dsh-ssh-helper-detail-actions' },
          h(Button, { variant: 'secondary', icon: 'edit', onClick: () => onEdit(resource) }, t('edit')),
          h(Button, { variant: 'secondary', icon: 'copy', onClick: () => onCopy(promptForUpdate(t, resource), t('promptCopied')) }, t('copyUpdatePrompt')),
          h(Button, { variant: 'danger', icon: 'trash', onClick: () => setConfirming(true) }, t('delete'))),
        confirming
          ? h(ConfirmInline, {
            t,
            title: t('deleteDeploymentTitle'),
            description: t('deleteDeploymentDesc'),
            onCancel: () => setConfirming(false),
            onConfirm: async () => { await onDelete(resource) },
          })
          : null,
        h(SectionLabel, { icon: 'folder' }, t('sectionDeployment')),
        h(MetaGrid, null,
          h(MetaRow, { label: t('fieldServer') }, h('span', { className: 'dsh-ssh-helper-mono' }, resource.serverName || t('unknownServer'))),
          h(MetaRow, { label: t('fieldAppDir'), onCopy: () => onCopy(resource.appDir), copyLabel: t('copyPath') }, h('span', { className: 'dsh-ssh-helper-mono dsh-ssh-helper-truncate', title: resource.appDir }, resource.appDir)),
          resource.serviceName === undefined || resource.serviceName === '' ? null : h(MetaRow, { label: t('fieldServiceName') }, h('span', { className: 'dsh-ssh-helper-mono' }, resource.serviceName)),
          h(MetaRow, { label: t('lastUpdated') }, h('span', { className: 'dsh-ssh-helper-muted' }, resource.lastUpdateAt === undefined || resource.lastUpdateAt === '' ? t('neverUpdated') : `${formatDateTime(resource.lastUpdateAt)} · ${formatRelative(resource.lastUpdateAt, t)}`)),
          Array.isArray(resource.tags) && resource.tags.length > 0 ? h(MetaRow, { label: t('fieldTags') }, h('div', { className: 'dsh-ssh-helper-view-actions' }, resource.tags.map((tag) => h(Chip, { key: tag, tone: 'neutral' }, tag)))) : null),
        h(SectionLabel, { icon: 'terminal' }, t('sectionCommands')),
        h(CodeBlock, { t, label: t('fieldUpdate'), value: resource.updateCommand, onCopy }),
        resource.restartCommand === undefined || resource.restartCommand === '' ? null : h(CodeBlock, { t, label: t('fieldRestart'), value: resource.restartCommand, onCopy }),
        resource.verifyCommand === undefined || resource.verifyCommand === '' ? null : h(CodeBlock, { t, label: t('fieldVerify'), value: resource.verifyCommand, onCopy }),
        h(SectionLabel, { icon: 'shield' }, t('sectionBackup')),
        h(MetaGrid, null,
          h(MetaRow, { label: t('fieldBackupEnabled') }, h(Chip, { tone: resource.backupEnabled === false ? 'idle' : 'success' }, resource.backupEnabled === false ? t('backupOff') : t('backupOn'))),
          resource.backupDir === undefined || resource.backupDir === '' ? null : h(MetaRow, { label: t('fieldBackupDir') }, h('span', { className: 'dsh-ssh-helper-mono dsh-ssh-helper-truncate', title: resource.backupDir }, resource.backupDir)),
          h(MetaRow, { label: t('fieldBackupKeep') }, h('span', null, fmt(t, 'backupKeepValue', { count: resource.backupKeep === undefined ? 5 : resource.backupKeep }))),
          h(MetaRow, { label: t('fieldTimeout') }, h('span', null, fmt(t, 'timeoutValue', { count: resource.timeoutSeconds === undefined ? 600 : resource.timeoutSeconds })))),
        h(SectionLabel, { icon: 'search' }, t('sectionDiscovery')),
        discovered === null
          ? h('p', { className: 'dsh-ssh-helper-form-hint' }, t('noDiscovery'))
          : h('div', { className: 'dsh-ssh-helper-form' },
            discovered.inspectedAt === undefined ? null : h('p', { className: 'dsh-ssh-helper-form-hint' }, fmt(t, 'discoveredAt', { time: formatDateTime(discovered.inspectedAt) })),
            Array.isArray(discovered.markers) && discovered.markers.length > 0 ? h('div', { className: 'dsh-ssh-helper-view-actions' }, discovered.markers.map((marker) => h(Chip, { key: marker, tone: 'brand' }, marker))) : null,
            discovered.gitRemote === undefined || discovered.gitRemote === '' ? null : h(MetaGrid, null, h(MetaRow, { label: t('gitRemote') }, h('span', { className: 'dsh-ssh-helper-mono dsh-ssh-helper-truncate' }, discovered.gitRemote))),
            discovered.gitBranch === undefined || discovered.gitBranch === '' ? null : h(MetaGrid, null, h(MetaRow, { label: t('gitBranch') }, h('span', { className: 'dsh-ssh-helper-mono' }, discovered.gitBranch))),
            Array.isArray(discovered.serviceUnits) && discovered.serviceUnits.length > 0 ? h(MetaGrid, null, h(MetaRow, { label: t('serviceUnits') }, h('span', { className: 'dsh-ssh-helper-mono dsh-ssh-helper-truncate', title: discovered.serviceUnits.join(', ') }, discovered.serviceUnits.join(', ')))) : null),
        h(SectionLabel, { icon: 'history' }, t('sectionRecentActivity')),
        activity.length === 0
          ? h('p', { className: 'dsh-ssh-helper-form-hint' }, t('noActivity'))
          : h('div', { className: 'dsh-ssh-helper-timeline' },
            activity.slice(0, 5).map((entry) => h('div', { key: entry.id, className: 'dsh-ssh-helper-activity' },
              h('div', { className: 'dsh-ssh-helper-activity-time' }, formatTimeOnly(entry.startedAt)),
              h('div', { className: 'dsh-ssh-helper-activity-axis' }, h(StatusDot, { tone: statusMeta(entry.status).tone })),
              h('div', { className: 'dsh-ssh-helper-activity-card' },
                h('div', { className: 'dsh-ssh-helper-activity-summary' },
                  h('div', { className: 'dsh-ssh-helper-activity-summary-main' },
                    h('div', { className: 'dsh-ssh-helper-activity-summary-title' }, `${actionLabel(t, entry.action)} · ${entry.resourceName}`),
                    h('div', { className: 'dsh-ssh-helper-activity-summary-sub' }, `${formatDuration(entry.durationMs)} · ${formatDateTime(entry.startedAt)}`))))))),
        activity.length > 5 ? h(Button, { variant: 'ghost', onClick: () => onViewActivity(resource) }, t('viewAllActivity')) : null,
        resource.note === undefined || resource.note === '' ? null : h('div', null,
          h(SectionLabel, { icon: 'edit' }, t('sectionNote')),
          h('p', { className: 'dsh-ssh-helper-form-hint' }, resource.note)))
    }

    // ---------------------------------------------------------------------
    // Lists
    // ---------------------------------------------------------------------

    function AccountRow(props) {
      const { t, account, result, selected, onOpen, onEdit, onTest } = props
      const initials = (account.name || account.username || '?').trim().slice(0, 2).toUpperCase()
      const testing = result !== null && result !== undefined && result.status === 'testing'
      return h('li', { className: cls('dsh-ssh-helper-row', selected && 'is-selected') },
        h('button', { type: 'button', className: 'dsh-ssh-helper-row-hit', onClick: () => onOpen(account), 'aria-label': `${t('open')}: ${account.name}` },
          h('div', { className: 'dsh-ssh-helper-avatar' }, initials),
          h('div', { className: 'dsh-ssh-helper-row-main' },
            h('div', { className: 'dsh-ssh-helper-row-title' },
              h('span', null, account.name),
              h(Chip, { tone: 'neutral' }, account.authType === 'key' ? t('authKey') : t('authPassword'))),
            h('div', { className: 'dsh-ssh-helper-row-sub' },
              h('span', { className: 'dsh-ssh-helper-mono' }, `${account.username}@${account.host}:${account.port}`),
              account.note === undefined || account.note === '' ? null : h('span', { className: 'dsh-ssh-helper-row-note' }, `· ${account.note}`)))),
        h('div', { className: 'dsh-ssh-helper-row-side' },
          testing
            ? h('span', { className: 'dsh-ssh-helper-spinner', title: t('testing') })
            : result !== null && result !== undefined
              ? h(Chip, { tone: result.status === 'ok' ? 'success' : 'error' }, result.status === 'ok' ? `${t('testOk')} · ${result.latencyMs || 0} ms` : t('testFail'))
              : null,
          h('div', { className: 'dsh-ssh-helper-row-actions' },
            h(IconButton, { icon: 'play', label: t('test'), onClick: (event) => { event.stopPropagation(); onTest(account) } }),
            h(IconButton, { icon: 'edit', label: t('edit'), onClick: (event) => { event.stopPropagation(); onEdit(account) } }),
            h(IconButton, { icon: 'chevron', label: t('open'), onClick: (event) => { event.stopPropagation(); onOpen(account) } }))))
    }

    function DeploymentRow(props) {
      const { t, resource, selected, onOpen, onEdit } = props
      const meta = statusMeta(resource.lastUpdateStatus)
      return h('li', { className: cls('dsh-ssh-helper-row', selected && 'is-selected') },
        h('button', { type: 'button', className: 'dsh-ssh-helper-row-hit', onClick: () => onOpen(resource), 'aria-label': `${t('open')}: ${resource.name}` },
          h(StatusDot, { tone: meta.tone }),
          h('div', { className: 'dsh-ssh-helper-row-main' },
            h('div', { className: 'dsh-ssh-helper-row-title' },
              h('span', null, resource.name),
              resource.serviceName === undefined || resource.serviceName === '' ? null : h(Chip, { tone: 'neutral' }, fmt(t, 'serviceValue', { name: resource.serviceName }))),
            h('div', { className: 'dsh-ssh-helper-row-sub' },
              h('span', { className: 'dsh-ssh-helper-mono' }, resource.serverName || t('unknownServer')),
              h('span', { className: 'dsh-ssh-helper-sep' }, '·'),
              h('span', { className: 'dsh-ssh-helper-mono dsh-ssh-helper-truncate', title: resource.appDir }, resource.appDir)))),
        h('div', { className: 'dsh-ssh-helper-row-side' },
          h(StatusChip, { t, status: resource.lastUpdateStatus }),
          h('span', { className: 'dsh-ssh-helper-row-time' }, resource.lastUpdateAt === undefined || resource.lastUpdateAt === '' ? t('neverUpdated') : formatRelative(resource.lastUpdateAt, t)),
          h('div', { className: 'dsh-ssh-helper-row-actions' },
            h(IconButton, { icon: 'edit', label: t('edit'), onClick: (event) => { event.stopPropagation(); onEdit(resource) } }),
            h(IconButton, { icon: 'chevron', label: t('open'), onClick: (event) => { event.stopPropagation(); onOpen(resource) } }))))
    }

    function importBanner(t, legacy, importing, onImport, onDismiss) {
      if (!legacy.available || legacy.count <= 0) return null
      return h('div', { className: 'dsh-ssh-helper-banner', key: 'import' },
        h(Icon, { name: 'link', size: 15 }),
        h('span', null, h('strong', null, t('importTitle')), ' · ', fmt(t, 'importDesc', { count: legacy.count })),
        h('div', { className: 'dsh-ssh-helper-banner-actions' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: onDismiss }, t('dismiss')),
          h(Button, { variant: 'primary', size: 'sm', loading: importing, onClick: onImport }, fmt(t, 'importAction', { count: legacy.count }))))
    }

    function AccountsView(props) {
      const { t, accounts, total, search, onSearch, filtersActive, onClear, testResults, onTest, onTestAll, testingAll, onAdd, onEdit, onOpen, legacy, importing, onImport, onDismissLegacy, selectedId } = props
      const pendingLegacy = legacy.available && legacy.count > 0
      return h('section', { className: 'dsh-ssh-helper-view' },
        h('div', { className: 'dsh-ssh-helper-view-head' },
          h('div', null, h('h3', null, t('accountsTitle')), h('p', null, t('accountsSubtitle'))),
          h('div', { className: 'dsh-ssh-helper-view-actions' },
            h(Button, { variant: 'ghost', icon: 'play', loading: testingAll, onClick: onTestAll, disabled: total === 0 }, t('testAll')),
            h(Button, { variant: 'primary', icon: 'plus', onClick: onAdd }, t('addServer')))),
        h('div', { className: 'dsh-ssh-helper-toolbar' },
          h(SearchBox, { value: search, onChange: onSearch, placeholder: t('searchAccounts') })),
        pendingLegacy ? importBanner(t, legacy, importing, onImport, onDismissLegacy) : null,
        total === 0
          ? h(EmptyState, {
            icon: 'server',
            title: t('emptyAccountsTitle'),
            description: t('emptyAccountsDesc'),
            actions: [h(Button, { key: 'add', variant: 'primary', icon: 'plus', onClick: onAdd }, t('addServer'))],
          })
          : accounts.length === 0
            ? h(EmptyState, { icon: 'search', title: t('emptySearchTitle'), description: t('emptySearchDesc'), actions: [h(Button, { key: 'clear', variant: 'secondary', onClick: onClear }, t('clearFilters'))] })
            : h('ul', { className: 'dsh-ssh-helper-list' },
              accounts.map((account) => h(AccountRow, {
                key: account.id,
                t,
                account,
                result: testResults[account.id],
                selected: selectedId === account.id,
                onOpen,
                onEdit,
                onTest,
              }))),
        h('p', { className: 'dsh-ssh-helper-footnote' }, h(Icon, { name: 'lock', size: 12 }), t('formHintAccount')))
    }

    function DeploymentsView(props) {
      const { t, resources, total, search, onSearch, filter, onFilter, onAdd, onEdit, onOpen, onCopyPrompt, hasAccounts, selectedId, onGoToAccounts } = props
      return h('section', { className: 'dsh-ssh-helper-view' },
        h('div', { className: 'dsh-ssh-helper-view-head' },
          h('div', null, h('h3', null, t('deploymentsTitle')), h('p', null, t('deploymentsSubtitle'))),
          h('div', { className: 'dsh-ssh-helper-view-actions' },
            h(Button, { variant: 'ghost', icon: 'copy', onClick: () => onCopyPrompt(promptForDiscovery(t)) }, t('copyDiscoveryPrompt')),
            h(Button, { variant: 'primary', icon: hasAccounts ? 'plus' : 'server', onClick: hasAccounts ? onAdd : onGoToAccounts }, hasAccounts ? t('addDeployment') : t('goToAccounts')))),
        h('div', { className: 'dsh-ssh-helper-toolbar' },
          h(SearchBox, { value: search, onChange: onSearch, placeholder: t('searchDeployments') }),
          h('div', { className: 'dsh-ssh-helper-filter-row', role: 'group', 'aria-label': t('searchDeployments') },
            ['all', 'success', 'issues', 'never'].map((value) => h('button', {
              key: value,
              type: 'button',
              className: 'dsh-ssh-helper-filter',
              'aria-pressed': filter === value ? 'true' : 'false',
              onClick: () => onFilter(value),
            }, value === 'all' ? t('filterAll') : value === 'success' ? t('filterSuccess') : value === 'issues' ? t('filterIssues') : t('filterNever'))))),
        total === 0
          ? h(EmptyState, {
            icon: 'terminal',
            title: hasAccounts ? t('emptyDeploymentsTitle') : t('emptyDeploymentsNoServer'),
            description: hasAccounts ? t('emptyDeploymentsDesc') : t('emptyDeploymentsNoServer'),
            actions: hasAccounts
              ? [
                h(Button, { key: 'add', variant: 'primary', icon: 'plus', onClick: onAdd }, t('addDeployment')),
                h(Button, { key: 'prompt', variant: 'secondary', icon: 'copy', onClick: () => onCopyPrompt(promptForDiscovery(t)) }, t('copyDiscoveryPrompt')),
              ]
              : [h(Button, { key: 'accounts', variant: 'primary', icon: 'server', onClick: onGoToAccounts }, t('goToAccounts'))],
          })
          : resources.length === 0
            ? h(EmptyState, { icon: 'search', title: t('emptySearchTitle'), description: t('emptySearchDesc'), actions: [h(Button, { key: 'clear', variant: 'secondary', onClick: () => { onSearch(''); onFilter('all') } }, t('clearFilters'))] })
            : h('ul', { className: 'dsh-ssh-helper-list' },
              resources.map((resource) => h(DeploymentRow, {
                key: resource.id,
                t,
                resource,
                selected: selectedId === resource.id,
                onOpen,
                onEdit,
              }))))
    }

    function ActivityStep(props) {
      const { t, step, onCopy } = props
      const meta = statusMeta(step.status)
      return h('div', { className: 'dsh-ssh-helper-step' },
        h('div', { className: 'dsh-ssh-helper-step-dot' }, h(StatusDot, { tone: meta.tone })),
        h('div', null,
          h('div', { className: 'dsh-ssh-helper-step-title' }, step.title),
          h('div', { className: 'dsh-ssh-helper-step-meta' },
            step.exitCode === null || step.exitCode === undefined ? null : h('span', null, fmt(t, 'exitCode', { code: step.exitCode })),
            h('span', null, fmt(t, 'duration', { value: formatDuration(step.durationMs) }))),
          step.command === undefined || step.command === '' ? null : h(CodeBlock, { t, label: t('sectionCommands'), value: step.command, onCopy }),
          step.stdoutTail === undefined || step.stdoutTail === '' ? null : h('div', { className: 'dsh-ssh-helper-output' },
            h('div', { className: 'dsh-ssh-helper-output-label' }, t('stdout')),
            h('pre', null, step.stdoutTail)),
          step.stderrTail === undefined || step.stderrTail === '' ? null : h('div', { className: 'dsh-ssh-helper-output' },
            h('div', { className: 'dsh-ssh-helper-output-label' }, t('stderr')),
            h('pre', null, step.stderrTail))))
    }

    function ActivityEntry(props) {
      const { t, entry, onCopy } = props
      const [open, setOpen] = useState(false)
      const meta = statusMeta(entry.status)
      return h('div', { className: 'dsh-ssh-helper-activity' },
        h('div', { className: 'dsh-ssh-helper-activity-time' }, formatTimeOnly(entry.startedAt)),
        h('div', { className: 'dsh-ssh-helper-activity-axis' }, h(StatusDot, { tone: meta.tone })),
        h('div', { className: 'dsh-ssh-helper-activity-card' },
          h('button', { type: 'button', className: 'dsh-ssh-helper-activity-summary', onClick: () => setOpen(!open), 'aria-expanded': open ? 'true' : 'false' },
            h('div', { className: 'dsh-ssh-helper-activity-summary-main' },
              h('div', { className: 'dsh-ssh-helper-activity-summary-title' },
                h('span', null, `${actionLabel(t, entry.action)} · ${entry.resourceName}`),
                h(StatusChip, { t, status: entry.status })),
              h('div', { className: 'dsh-ssh-helper-activity-summary-sub' },
                `${entry.serverName || t('unknownServer')} · ${formatDuration(entry.durationMs)} · ${formatDateTime(entry.startedAt)}`)),
            h(Icon, { name: open ? 'chevronDown' : 'chevron', size: 15 })),
          open ? h('div', { className: 'dsh-ssh-helper-activity-body' },
            entry.message === undefined || entry.message === '' ? null : h('p', { className: 'dsh-ssh-helper-activity-message' }, entry.message),
            Array.isArray(entry.steps) && entry.steps.length > 0
              ? h('div', null, h(SectionLabel, null, t('steps')), entry.steps.map((step, index) => h(ActivityStep, { key: `${entry.id}-${index}`, t, step, onCopy })))
              : h('p', { className: 'dsh-ssh-helper-form-hint' }, t('noOutput'))) : null))
    }

    function ActivityView(props) {
      const { t, entries, total, search, onSearch, filter, onFilter, onRefresh, onCopy, refreshing } = props
      const groups = groupHistoryByDay(entries)
      return h('section', { className: 'dsh-ssh-helper-view' },
        h('div', { className: 'dsh-ssh-helper-view-head' },
          h('div', null, h('h3', null, t('activityTitle')), h('p', null, t('activitySubtitle'))),
          h('div', { className: 'dsh-ssh-helper-view-actions' },
            h(Button, { variant: 'secondary', icon: 'refresh', loading: refreshing, onClick: onRefresh }, t('refresh')))),
        h('div', { className: 'dsh-ssh-helper-toolbar' },
          h(SearchBox, { value: search, onChange: onSearch, placeholder: t('searchActivity') }),
          h('div', { className: 'dsh-ssh-helper-filter-row', role: 'group', 'aria-label': t('searchActivity') },
            ['all', 'success', 'issues'].map((value) => h('button', {
              key: value,
              type: 'button',
              className: 'dsh-ssh-helper-filter',
              'aria-pressed': filter === value ? 'true' : 'false',
              onClick: () => onFilter(value),
            }, value === 'all' ? t('filterAll') : value === 'success' ? t('filterSuccess') : t('filterIssues'))))),
        total === 0
          ? h(EmptyState, { icon: 'history', title: t('emptyActivityTitle'), description: t('emptyActivityDesc') })
          : entries.length === 0
            ? h(EmptyState, { icon: 'search', title: t('emptySearchTitle'), description: t('emptySearchDesc'), actions: [h(Button, { key: 'clear', variant: 'secondary', onClick: () => { onSearch(''); onFilter('all') } }, t('clearFilters'))] })
            : h('div', { className: 'dsh-ssh-helper-timeline' },
              groups.map((group) => h('div', { key: group.key },
                h('div', { className: 'dsh-ssh-helper-day' }, group.key),
                group.entries.map((entry) => h(ActivityEntry, { key: entry.id, t, entry, onCopy }))))))
    }

    // ---------------------------------------------------------------------
    // Section
    // ---------------------------------------------------------------------

    function Section(props) {
      const t = props.t
      const rootRef = useRef(null)
      const mounted = useRef(true)
      const toastSeq = useRef(0)
      const viewChosen = useRef(false)
      const [bootStatus, setBootStatus] = useState('loading')
      const [bootError, setBootError] = useState('')
      const [partialError, setPartialError] = useState(false)
      const [accounts, setAccounts] = useState([])
      const [resources, setResources] = useState([])
      const [history, setHistory] = useState([])
      const [legacy, setLegacy] = useState({ available: false, count: 0 })
      const [legacyDismissed, setLegacyDismissed] = useState(readLegacyDismissed)
      const [view, setView] = useState('accounts')
      const [accountSearch, setAccountSearch] = useState('')
      const [deploymentSearch, setDeploymentSearch] = useState('')
      const [activitySearch, setActivitySearch] = useState('')
      const [deploymentFilter, setDeploymentFilter] = useState('all')
      const [activityFilter, setActivityFilter] = useState('all')
      const [selectedAccountId, setSelectedAccountId] = useState(null)
      const [selectedResourceId, setSelectedResourceId] = useState(null)
      const [sheet, setSheet] = useState(null)
      const [testResults, setTestResults] = useState({})
      const [testingAll, setTestingAll] = useState(false)
      const [importing, setImporting] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const [toasts, setToasts] = useState([])

      function pushToast(message, tone) {
        toastSeq.current += 1
        const id = toastSeq.current
        setToasts((previous) => [...previous, { id, message, tone: tone === undefined ? 'success' : tone }])
        window.setTimeout(() => {
          setToasts((previous) => previous.filter((toast) => toast.id !== id))
        }, tone === 'error' ? 6000 : 3500)
      }

      function dismissToast(id) {
        setToasts((previous) => previous.filter((toast) => toast.id !== id))
      }

      async function loadAll(initial) {
        if (initial) setBootStatus('loading')
        setBootError('')
        setPartialError(false)
        const results = await Promise.allSettled([
          call('accounts/list'),
          call('resources/list'),
          call('history/list', { limit: 200 }),
        ])
        if (!mounted.current) return false
        let failed = 0
        if (results[0].status === 'fulfilled' && results[0].value !== null && typeof results[0].value === 'object') {
          setAccounts(Array.isArray(results[0].value.accounts) ? results[0].value.accounts : [])
          setLegacy(results[0].value.legacy !== null && typeof results[0].value.legacy === 'object' ? results[0].value.legacy : { available: false, count: 0 })
        } else {
          failed += 1
        }
        if (results[1].status === 'fulfilled' && results[1].value !== null && typeof results[1].value === 'object') {
          setResources(Array.isArray(results[1].value.resources) ? results[1].value.resources : [])
        } else {
          failed += 1
        }
        if (results[2].status === 'fulfilled' && results[2].value !== null && typeof results[2].value === 'object') {
          setHistory(Array.isArray(results[2].value.history) ? results[2].value.history : [])
        } else {
          failed += 1
        }
        if (failed === 3) {
          setBootStatus('error')
          setBootError(errorMessage(results[0].reason, t('loadFailed')))
          return false
        }
        if (failed > 0) setPartialError(true)
        setBootStatus('ready')
        if (!viewChosen.current) {
          viewChosen.current = true
          const accountCount = results[0].status === 'fulfilled' && results[0].value && Array.isArray(results[0].value.accounts) ? results[0].value.accounts.length : 0
          const resourceCount = results[1].status === 'fulfilled' && results[1].value && Array.isArray(results[1].value.resources) ? results[1].value.resources.length : 0
          setView(resourceCount > 0 || accountCount > 0 ? (resourceCount > 0 ? 'deployments' : 'accounts') : 'accounts')
        }
        return failed === 0
      }

      useEffect(() => {
        mounted.current = true
        loadAll(true)
        return () => { mounted.current = false }
      }, [])

      useEffect(() => {
        function onKeyDown(event) {
          if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
          if (event.key !== '/') return
          if (sheet !== null || isEditable(event.target)) return
          const input = rootRef.current === null ? null : rootRef.current.querySelector('.dsh-ssh-helper-search input')
          if (input !== null) {
            event.preventDefault()
            input.focus()
            input.select()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [sheet])

      async function refreshAll() {
        setRefreshing(true)
        const ok = await loadAll(false)
        if (!mounted.current) return
        setRefreshing(false)
        if (!ok) pushToast(t('toastRefreshFailed'), 'error')
      }

      async function refreshAccounts() {
        try {
          const data = await call('accounts/list')
          if (!mounted.current) return
          setAccounts(Array.isArray(data.accounts) ? data.accounts : [])
          setLegacy(data.legacy !== null && typeof data.legacy === 'object' ? data.legacy : { available: false, count: 0 })
        } catch (caught) {
          if (mounted.current) pushToast(errorMessage(caught, t('toastRefreshFailed')), 'error')
        }
      }

      async function refreshResources() {
        try {
          const data = await call('resources/list')
          if (mounted.current) setResources(Array.isArray(data.resources) ? data.resources : [])
        } catch (caught) {
          if (mounted.current) pushToast(errorMessage(caught, t('toastRefreshFailed')), 'error')
        }
      }

      async function refreshHistory() {
        try {
          const data = await call('history/list', { limit: 200 })
          if (mounted.current) setHistory(Array.isArray(data.history) ? data.history : [])
        } catch (caught) {
          if (mounted.current) pushToast(errorMessage(caught, t('toastRefreshFailed')), 'error')
        }
      }

      async function refreshActivity() {
        setRefreshing(true)
        await refreshHistory()
        if (mounted.current) setRefreshing(false)
      }

      async function copyValue(value, message) {
        try {
          await copyText(value)
          pushToast(typeof message === 'string' && message !== '' ? message : t('toastCopied'))
        } catch {
          pushToast(t('toastCopyFailed'), 'error')
        }
      }

      async function copyPrompt(value) {
        await copyValue(value, t('promptCopied'))
      }

      async function testAccount(account) {
        setTestResults((previous) => ({ ...previous, [account.id]: { status: 'testing' } }))
        try {
          const data = await call('accounts/test', { id: account.id })
          if (!mounted.current) return
          setTestResults((previous) => ({
            ...previous,
            [account.id]: {
              status: data.success === true ? 'ok' : 'fail',
              latencyMs: data.latencyMs,
              message: data.message,
              output: data.output,
            },
          }))
        } catch (caught) {
          if (!mounted.current) return
          setTestResults((previous) => ({ ...previous, [account.id]: { status: 'fail', message: errorMessage(caught, t('testFail')) } }))
        }
      }

      async function testAll() {
        setTestingAll(true)
        try {
          for (const account of accounts) {
            if (!mounted.current) return
            await testAccount(account)
          }
          if (mounted.current) pushToast(t('toastTested'))
        } finally {
          if (mounted.current) setTestingAll(false)
        }
      }

      function dismissLegacy() {
        writeLegacyDismissed()
        setLegacyDismissed(true)
      }

      async function importLegacy() {
        setImporting(true)
        try {
          const data = await call('accounts/import')
          await refreshAccounts()
          if (!mounted.current) return
          dismissLegacy()
          pushToast(fmt(t, 'toastImported', { imported: data.imported, skipped: data.skipped }))
        } catch (caught) {
          if (mounted.current) pushToast(errorMessage(caught, t('toastImportFailed')), 'error')
        } finally {
          if (mounted.current) setImporting(false)
        }
      }

      async function saveAccount(account) {
        await refreshAccounts()
        if (!mounted.current) return
        setSelectedAccountId(account.id)
        setSheet(null)
        pushToast(t('toastSaved'))
      }

      async function saveResource(resource) {
        await refreshResources()
        if (!mounted.current) return
        setSelectedResourceId(resource.id)
        setSheet(null)
        pushToast(t('toastSaved'))
      }

      async function deleteAccount(account) {
        await call('accounts/delete', { id: account.id })
        if (!mounted.current) return
        setSheet(null)
        setSelectedAccountId(null)
        await refreshAccounts()
        pushToast(t('toastDeleted'))
      }

      async function deleteResource(resource) {
        await call('resources/delete', { id: resource.id })
        if (!mounted.current) return
        setSheet(null)
        setSelectedResourceId(null)
        await refreshResources()
        await refreshHistory()
        pushToast(t('toastDeleted'))
      }

      function openAccount(account) {
        setSelectedAccountId(account.id)
        setSheet({ type: 'account-detail', id: account.id })
      }

      function openResource(resource) {
        setSelectedResourceId(resource.id)
        setSheet({ type: 'resource-detail', id: resource.id })
      }

      function openAccountForm(account) {
        setSheet({ type: 'account-form', id: account === undefined ? undefined : account.id })
      }

      function openResourceForm(resource) {
        setSheet({ type: 'resource-form', id: resource === undefined ? undefined : resource.id })
      }

      function goToAccounts() {
        viewChosen.current = true
        setView('accounts')
        setSheet(null)
      }

      const accountById = new Map(accounts.map((account) => [account.id, account]))
      const resourceById = new Map(resources.map((resource) => [resource.id, resource]))

      const accountQuery = accountSearch.trim().toLowerCase()
      const filteredAccounts = accounts.filter((account) => {
        if (accountQuery === '') return true
        return [account.name, account.host, account.username, account.note]
          .some((value) => text(value).toLowerCase().includes(accountQuery))
      })

      const deploymentQuery = deploymentSearch.trim().toLowerCase()
      const filteredResources = resources.filter((resource) => {
        const matchesQuery = deploymentQuery === '' || [resource.name, resource.serverName, resource.appDir, resource.serviceName, resource.note, ...(Array.isArray(resource.tags) ? resource.tags : [])]
          .some((value) => text(value).toLowerCase().includes(deploymentQuery))
        return matchesQuery && matchStatusFilter(resource.lastUpdateStatus, deploymentFilter)
      })

      const activityQuery = activitySearch.trim().toLowerCase()
      const filteredHistory = history.filter((entry) => {
        const matchesQuery = activityQuery === '' || [entry.resourceName, entry.serverName, entry.appDir, entry.status, entry.action]
          .some((value) => text(value).toLowerCase().includes(activityQuery))
        return matchesQuery && matchStatusFilter(entry.status, activityFilter)
      })

      const lastEntry = history.length > 0 ? history[0] : null
      const lastMeta = lastEntry === null ? { tone: 'idle' } : statusMeta(lastEntry.status)

      let sheetNode = null
      if (sheet !== null && sheet.type === 'account-detail') {
        const account = accountById.get(sheet.id)
        if (account !== undefined) {
          sheetNode = h(Sheet, { t, title: t('accountDetail'), subtitle: account.name, onClose: () => setSheet(null) },
            h(AccountDetail, {
              t,
              account,
              testResult: testResults[account.id],
              onTest: testAccount,
              onEdit: openAccountForm,
              onDelete: deleteAccount,
              onCopy: copyValue,
              onClose: () => setSheet(null),
            }))
        }
      } else if (sheet !== null && sheet.type === 'account-form') {
        const account = sheet.id === undefined ? null : accountById.get(sheet.id)
        sheetNode = h(Sheet, {
          t,
          title: account === null || account === undefined ? t('accountAddTitle') : t('accountEditTitle'),
          subtitle: account === null || account === undefined ? undefined : account.name,
          onClose: () => setSheet(null),
          wide: true,
        }, h(AccountForm, {
          t,
          account,
          onSaved: saveAccount,
          onClose: () => setSheet(null),
        }))
      } else if (sheet !== null && sheet.type === 'resource-detail') {
        const resource = resourceById.get(sheet.id)
        if (resource !== undefined) {
          sheetNode = h(Sheet, { t, title: t('resourceDetail'), subtitle: resource.name, onClose: () => setSheet(null) },
            h(ResourceDetail, {
              t,
              resource,
              activity: history.filter((entry) => entry.resourceId === resource.id),
              onEdit: openResourceForm,
              onDelete: deleteResource,
              onCopy: copyValue,
              onViewActivity: (target) => {
                setActivitySearch(target.name)
                setActivityFilter('all')
                setView('activity')
                setSheet(null)
              },
            }))
        }
      } else if (sheet !== null && sheet.type === 'resource-form') {
        const resource = sheet.id === undefined ? null : resourceById.get(sheet.id)
        sheetNode = h(Sheet, {
          t,
          title: resource === null || resource === undefined ? t('resourceAddTitle') : t('resourceEditTitle'),
          subtitle: resource === null || resource === undefined ? undefined : resource.name,
          onClose: () => setSheet(null),
          wide: true,
        }, h(ResourceForm, {
          t,
          resource,
          accounts,
          onSaved: saveResource,
          onClose: () => setSheet(null),
        }))
      }

      const railItems = [
        { id: 'accounts', icon: 'server', label: t('viewAccounts'), count: accounts.length },
        { id: 'deployments', icon: 'terminal', label: t('viewDeployments'), count: resources.length },
        { id: 'activity', icon: 'history', label: t('viewActivity'), count: history.length },
      ]

      let content = null
      if (bootStatus === 'loading') {
        content = h('div', { className: 'dsh-ssh-helper-loading-panel' },
          h('p', null, t('loading')),
          h(SkeletonList, { rows: 4 }))
      } else if (bootStatus === 'error') {
        content = h('div', { className: 'dsh-ssh-helper-error-panel' },
          h(Icon, { name: 'alert', size: 22 }),
          h('h4', null, t('loadFailed')),
          h('p', null, bootError || t('toastLoadFailed')),
          h(Button, { variant: 'primary', icon: 'refresh', onClick: () => loadAll(true) }, t('retry')))
      } else if (view === 'accounts') {
        content = h(AccountsView, {
          t,
          accounts: filteredAccounts,
          total: accounts.length,
          search: accountSearch,
          onSearch: setAccountSearch,
          filtersActive: accountSearch !== '',
          onClear: () => setAccountSearch(''),
          testResults,
          onTest: testAccount,
          onTestAll: testAll,
          testingAll,
          onAdd: () => openAccountForm(),
          onEdit: openAccountForm,
          onOpen: openAccount,
          legacy: legacyDismissed ? { available: false, count: 0 } : legacy,
          importing,
          onImport: importLegacy,
          onDismissLegacy: dismissLegacy,
          selectedId: selectedAccountId,
        })
      } else if (view === 'deployments') {
        content = h(DeploymentsView, {
          t,
          resources: filteredResources,
          total: resources.length,
          search: deploymentSearch,
          onSearch: setDeploymentSearch,
          filter: deploymentFilter,
          onFilter: setDeploymentFilter,
          onAdd: () => openResourceForm(),
          onEdit: openResourceForm,
          onOpen: openResource,
          onCopyPrompt: copyPrompt,
          hasAccounts: accounts.length > 0,
          selectedId: selectedResourceId,
          onGoToAccounts: goToAccounts,
        })
      } else {
        content = h(ActivityView, {
          t,
          entries: filteredHistory,
          total: history.length,
          search: activitySearch,
          onSearch: setActivitySearch,
          filter: activityFilter,
          onFilter: setActivityFilter,
          onRefresh: refreshActivity,
          onCopy: copyValue,
          refreshing,
        })
      }

      return h('div', { className: 'dsh-ssh-helper-page', ref: rootRef },
        h('div', { className: 'dsh-ssh-helper-section' },
          h('div', { className: 'dsh-ssh-helper-shell' },
          h('header', { className: 'dsh-ssh-helper-hero' },
            h('div', { className: 'dsh-ssh-helper-hero-main' },
              h('div', { className: 'dsh-ssh-helper-brand' },
                h('div', { className: 'dsh-ssh-helper-brand-mark' }, h(Icon, { name: 'terminal', size: 20 })),
                h('div', null,
                  h('h2', null, t('title')),
                  h('p', null, t('subtitle')))),
              h('span', { className: 'dsh-ssh-helper-hero-pill' }, h(Icon, { name: 'shield', size: 13 }), t('approvalPill'))),
            h('div', { className: 'dsh-ssh-helper-stats' },
              h('div', { className: 'dsh-ssh-helper-stat' },
                h('span', { className: 'dsh-ssh-helper-stat-label' }, t('statServers')),
                h('span', { className: 'dsh-ssh-helper-stat-value' }, String(accounts.length))),
              h('div', { className: 'dsh-ssh-helper-stat' },
                h('span', { className: 'dsh-ssh-helper-stat-label' }, t('statDeployments')),
                h('span', { className: 'dsh-ssh-helper-stat-value' }, String(resources.length))),
              h('div', { className: 'dsh-ssh-helper-stat' },
                h('span', { className: 'dsh-ssh-helper-stat-label' }, t('statLastUpdate')),
                h('span', { className: 'dsh-ssh-helper-stat-value' },
                  h(StatusDot, { tone: lastMeta.tone }),
                  lastEntry === null ? t('statNone') : formatRelative(lastEntry.startedAt, t))),
              h(IconButton, { icon: 'refresh', label: t('refresh'), onClick: refreshAll, disabled: refreshing }))),
          h('div', { className: 'dsh-ssh-helper-console' },
            h('nav', { className: 'dsh-ssh-helper-rail', 'aria-label': t('nav') },
              railItems.map((item) => h('button', {
                key: item.id,
                type: 'button',
                className: 'dsh-ssh-helper-rail-item',
                'aria-current': view === item.id ? 'page' : undefined,
                onClick: () => { viewChosen.current = true; setView(item.id); setSheet(null) },
              },
              h('span', { className: 'dsh-ssh-helper-rail-icon' }, h(Icon, { name: item.icon, size: 16 })),
              h('span', { className: 'dsh-ssh-helper-rail-label' }, item.label),
              h('span', { className: 'dsh-ssh-helper-rail-count' }, String(item.count)))),
              h('div', { className: 'dsh-ssh-helper-rail-note' },
                h(Icon, { name: 'shield', size: 14 }),
                h('div', null,
                  h('strong', null, t('approvalNote')),
                  h('span', { title: t('approvalNoteDesc') }, t('approvalPill'))))),
            h('main', { className: 'dsh-ssh-helper-main' },
              partialError ? h('div', { className: 'dsh-ssh-helper-error-banner', role: 'alert' },
                h(Icon, { name: 'alert', size: 14 }),
                t('partialLoad'),
                h(Button, { variant: 'ghost', size: 'sm', onClick: refreshAll }, t('retry'))) : null,
              content)))),
        sheetNode,
        h(ToastStack, { toasts, onDismiss: dismissToast }))
    }

    // ---------------------------------------------------------------------
    // Plugin mount
    // ---------------------------------------------------------------------

    /**
     * Sidebar icon for the global panel row. The host supplies `size` and
     * `active`; the row owns the button, label and active styling.
     * @param {{ size?: number, active?: boolean }} props - icon presentation.
     * @returns {object} icon element.
     */
    function PanelIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 20
      return h(Icon, { name: 'terminal', size })
    }

    function apply(ctx) {
      const translate = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-ssh-helper: locale dictionary')
      ctx.effect(installStyles, 'dsh-ssh-helper: stylesheet')
      const Page = (slotProps) => h(Section, {
        t: slotProps !== null && slotProps !== undefined && typeof slotProps.t === 'function' ? slotProps.t : translate,
      })
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'ssh-helper',
        locale: LOCALE_NS,
        inject: () => ({ t: translate }),
      }, Page)), 'dsh-ssh-helper: main panel')
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'ssh-helper',
        order: 15,
        locale: LOCALE_NS,
        label: () => translate('nav'),
      }, PanelIcon)), 'dsh-ssh-helper: sidebar entry')
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
