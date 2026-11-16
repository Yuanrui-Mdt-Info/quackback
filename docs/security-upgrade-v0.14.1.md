# v0.14.1 Faray 依赖安全修复验证

验证日期：2026-11-05。分支：`codex/upgrade-v0.14.1-faray`。基线：`c28cbc248`（上游 v0.14.1 加 Faray 定制）。仅本地修改和验证，未部署生产。

## 升级范围

本轮目标为生产依赖审计的 13 条高危/严重条目（9 high + 4 critical；12 个不同 GHSA，TanStack 的同一告警涉及两个包）。未添加安全白名单，也未修改生产数据库结构。

| 依赖                                | 原版本   | 修复版本                       |
| ----------------------------------- | -------- | ------------------------------ |
| Better Auth、MCP/OAuth 插件及适配器 | 1.7.4    | 1.7.7                          |
| MCP SDK                             | 1.31.0   | 1.32.0                         |
| TanStack React Start                | 1.168.52 | 1.168.60                       |
| TanStack Start Server Core          | 1.169.34 | 1.169.39                       |
| TanStack React Router               | 1.170.35 | 1.170.41（与 Start 配套）      |
| body-parser                         | 2.2.2    | 2.4.0                          |
| DOMPurify                           | 3.4.15   | 3.4.17                         |
| Seroval                             | 1.6.4    | 1.6.11                         |
| seroval-plugins                     | 1.6.4    | 1.6.7（Router 要求的最低版本） |
| Zod                                 | 4.6.4    | 4.6.6（全部工作区统一）        |

其余锁文件变化来自上述包的必需传递依赖。Seroval 1.6.8 已修复原有高危，但仍有两个中危，因此选择同系列 1.6.11。固定安全 override，避免安装时重新引入旧版或漂移到不必要的新版本。

## 认证兼容性

Better Auth 1.7.7 要求魔术链接以 `magic-link:<token>` 作为验证记录标识，记录内容严格采用 `{ type: 'magic-link', email }`。项目原先绕过 sign-in API 自行签发邀请/恢复/邮件登录链接，旧格式升级后不能消费，因此同步修复签发、单条撤销、批量撤销以及 E2E 取 token 脚本。URL 和邀请表仍保存不带前缀的公开 token。

新增真实 Better Auth + memory adapter 合约回归，覆盖内部签发链接首次消费、重放拒绝、旧格式和其他用途记录拒绝；撤销测试检查完整的带前缀条件。未添加对旧无类型记录的兼容读取，以保留上游安全隔离。

未来部署时：升级前尚未使用的魔术链接（含邀请邮件中的直接登录链接）应重新签发；进行中的 OAuth/SAML 登录需重新开始。已有会话没有在本次修改中主动失效。生产回滚和真实身份提供商验收仍需另行安排。参考 [Better Auth 官方安全公告](https://github.com/advisories/GHSA-965c-763c-88jm)。

## 安全审计

- `bun audit --production --json`：高危 9 → 0，严重 4 → 0；剩余中危 24、低危 5。
- `bun scripts/audit-check.ts`：PASS；`.audit-allowlist.json` 未变更，未新增豁免。
- 原始 audit 返回码仍为 1，因为仍有低/中危；不能据此称“所有漏洞清零”。
- 补充 `bun audit --json`（包含开发依赖）：仍有 high 7、critical 0、moderate 36、low 7。这 7 条属于额外的开发/测试工具告警，不是本次的 13 条生产条目。Happy DOM 20.14.5 的完整修复需要升级至 21.0.4，涉及主版本变化，留待单独兼容验证；Undici/Vite 可单独采用小版本补丁。

### 已消除的原始高危/严重条目

- `@modelcontextprotocol/sdk`：[GHSA-22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw)（high）
- `@modelcontextprotocol/sdk`：[GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453)（high）
- `@tanstack/react-start`：[GHSA-qx66-fv34-fjm8](https://github.com/advisories/GHSA-qx66-fv34-fjm8)（critical）
- `@tanstack/start-server-core`：[GHSA-qx66-fv34-fjm8](https://github.com/advisories/GHSA-qx66-fv34-fjm8)（critical）
- `better-auth`：[GHSA-r4xp-prcw-77qf](https://github.com/advisories/GHSA-r4xp-prcw-77qf)（high）
- `better-auth`：[GHSA-965c-763c-88jm](https://github.com/advisories/GHSA-965c-763c-88jm)（critical）
- `body-parser`：[GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)（high）
- `dompurify`：[GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7)（critical）
- `dompurify`：[GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr)（high）
- `seroval`：[GHSA-97r2-qh9m-474h](https://github.com/advisories/GHSA-97r2-qh9m-474h)（high）
- `seroval`：[GHSA-wp97-x4hv-qvhp](https://github.com/advisories/GHSA-wp97-x4hv-qvhp)（high）
- `seroval`：[GHSA-7rv5-mrxv-xcr9](https://github.com/advisories/GHSA-7rv5-mrxv-xcr9)（high）
- `zod`：[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)（high）

### 另行记录的开发依赖高危

- `happy-dom`：[GHSA-834v-8h66-3h79](https://github.com/advisories/GHSA-834v-8h66-3h79)
- `happy-dom`：[GHSA-c8p4-j97h-3vg8](https://github.com/advisories/GHSA-c8p4-j97h-3vg8)
- `undici`：[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)
- `undici`：[GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26)
- `undici`：[GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx)
- `undici`：[GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm)
- `vite`：[GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm)

## 验证记录

| 检查                                    | 结果                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| Bun 1.4.0 frozen lockfile 离线安装      | 通过，无锁文件变化                                                                |
| Web + workspace probe TypeScript 检查   | 通过                                                                              |
| oxlint                                  | 通过，69 条既有 warning                                                           |
| Widget SDK 构建及测试                   | 构建通过，90/90 测试通过                                                          |
| Web 生产构建                            | 通过                                                                              |
| Server Function Manifest                | 822 entries / 822 call sites，通过                                                |
| Widget bundle                           | 43 chunks / 377 KB gzip，低于 60 / 420 KB 预算                                    |
| 新旧内部魔术链接格式和撤销回归          | 11/11 通过（含 3 项真实 Better Auth 合约测试）                                    |
| 根目录完整 Vitest 套件                  | 1,925 文件通过、5 文件跳过；19,157 测试通过、21 跳过、1 todo，0 失败（495.96 秒） |
| Playwright Widget surfaces + identified | 10/10 通过                                                                        |
| Playwright 管理端登录及 Widget 设置     | 4/4 通过（包含 setup/cleanup）                                                    |
| Playwright 统一登录选定场景             | 5/5 通过                                                                          |
| 浏览器 Widget → Portal 登录             | 首次和已有 Cookie 两次均成功，session scope=portal                                |
| Faray 品牌                              | 桌面、390px 移动端、管理端预览名称/Logo/链接均正确                                |

统一登录测试的私有门户场景首次因生产进程的 5 秒设置缓存未失效而失败（fixture 在另一个进程直接修改数据库）。使用已有的 `QUACKBACK_SETTINGS_CACHE_MS=0` 本地测试配置后，全部五项通过；未修改产品缓存代码或放宽断言。浏览器品牌 smoke 没有应用 pageerror；保留 Chromium 对上游 iframe sandbox 配置的提示。未连接真实外部 OAuth/SAML 提供商，也未验证真实邮件投递。

本地原始日志保存在 `/private/tmp/quackback-security-fix/`；数据库使用本地 Docker 临时 PostgreSQL，端口 55441，未连接生产。浏览器针对本地生产构建端口 31441，邮件提供方为 console，没有实际发送邮件。
