# 开发约定

工作区用 pnpm 管理，依赖放置遵循一条原则：

> **依赖声明在使用它的包里。** 根 `package.json` 只放全仓工具链（eslint、typescript、vitest 等）；
> 某个包 import 到的依赖，必须写进该包自己的 `package.json`。pnpm 的 `node_modules` 是隔离的，
> 子包解析不到根里「替它装」的依赖——typecheck / eslint 在子包内跑时会挂，而根目录跑测试可能掩盖问题
> （实例：`@testing-library/react` 曾因只装在根导致 `apps/web` 的 typecheck 失败）。

架构决策与不变式见 [CONTEXT.md](CONTEXT.md)；优化基线与验收口径见 [docs/optimization-plan.md](docs/optimization-plan.md)；部署见 [DEPLOY.md](DEPLOY.md)。
