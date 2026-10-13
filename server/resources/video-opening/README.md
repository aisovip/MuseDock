# 通用提问开场

`card_stack.py` 只负责将按序成品图片、问题文字和指定帧数渲染成无音轨的 H.264 开场。支持横屏和竖屏，保留图片完整比例，问题在独立底部区域显示。

Node 调用入口：`server/services/creative/shared/videoOpeningRenderer.js` 的 `renderVideoOpening(spec, runtime, options)`。

- `spec`：`images`（已验证的本地路径数组）、`question`、`output`、`canvas: {width,height}`、`fps`、`frameCount`。
- `runtime`：调用方提供 `execute`、`pythonPath`、`ffmpeg`、`font` 和可选 `encoderThreads`。
- `options`：透传取消信号、超时和进度回调。
- 返回实际图片出场帧、图片数量和总帧数；调用方负责校验成片及保存产物。

模块不读取创作任务、API 配置、白板落墨标注，也不生成图片或配音。各创作模式负责准备问题、按序图片及开场时长，再将开场与正文连接。音频使用整轨旁白时，开场边界来自同请求原生时间戳；无旁白时由阅读时长决定。以绝对帧边界分配片段，避免逐段取整造成总帧数误差。

白板适配器在 `whiteboard/mediaTools.js` 与 `whiteboard/productionStages.js`。渲染源文件哈希、问题、时间边界和全部图片哈希参与最终产物身份。关闭开场的旧任务保持原合同和默认行为。
