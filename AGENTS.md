# Agent notes — mieru / wg panel

## 用户口令

- **「调用小爱」** = 调用 **ui-ux-pro-max** skill，用于 **mieru 面板** 的 UI/UX 设计与改版。
- 触发后：先按 skill 出设计方案（风格/色板/字体/组件），再改 `public/css`、`public/index.html`、`public/js` 相关前端，必要时再发版。
- 设计基调已锁定：**Premium Ops Console**（OLED Dark + Glass + Dense Bento，Inter + JetBrains Mono，主色 `#5B8CFF` + cyan）。设计系统参考：`design-system/design-system/mieru-panel/MASTER.md`（本地，可能 gitignore）。

## 版本约定

- 纯前端视觉改动：升面板小版本即可，Agent 协议无改则不必升 Agent。
- 当前 Premium UI 自 **v4.5.0** 起；Ops UX 全量自 **v4.6.2** 起。
