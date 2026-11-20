# 创意预览 Checkpoint 实验报告

日期：2026-11-19

## 结论

本地实现通过了从 Motion 评测集选出的 5 条隔离端到端 checkpoint 场景。5 条场景都完成了源码编排、生成完成、MP4 导出和可播放媒体回读。

高风险路径成功强制要求可播放的 `motion_sample`，在确认前拦截正式导出，支持 production 阶段重设计，并在重新确认后再次记录 `production_started`。

本轮没有发现确定性的实现缺陷。完整仓库测试仍有部分失败，原因是仓库中缺少已有媒体文件和 LFS 内容。

## 评测来源与场景选择

评测来源是飞书 [Motion 评测集](https://powerformer.feishu.cn/wiki/Od1Qwdey3ilmQJkPGErcXwPunof) 的 `评测集v1.0` 工作表。读取时共有 51 个唯一 task chain、104 行有效记录，空白行未计入。

本轮按照 checkpoint 状态和交付链路选择代表场景。

| Motion task | 覆盖路径 | 选择原因 |
| --- | --- | --- |
| `motion_001` | 方向不清晰、高 motion risk、motion sample、确认 production、production 重设计 | 覆盖方向清晰度 × motion risk 流程中约束最严格的路径，并验证第二次 production start。 |
| `motion_014` | 方向清晰、低风险、storyboard、确认、production | 覆盖最短的普通 checkpoint 路径。 |
| `motion_029` | 简单模板适配跳过 | 验证允许的 skip reason 和跳过后的 production gate。 |
| `motion_037` | 没有 checkpoint 数据的历史 work round | 验证旧 work round 的向后兼容。 |
| `motion_002` | 方向修订、已保存预览切换、请求重放 | 验证修订历史、已保存预览选择和请求幂等。 |

端到端运行使用了这些 Motion 行的任务 brief 和验收意图。为隔离验证 workflow、持久化身份、渲染和导出链路，本轮使用确定性的 native HTML/GSAP fixture 生成本地影片，没有依赖当前不可用的外部附件或付费媒体 provider。

## 实验过程

运行过程使用独立的临时 `WorkspaceStore`，代码基于 commit `58d8c33` 加上本次未提交的 checkpoint 实现。每条场景都创建独立工程和独立 work round。

适用时，每条场景依次执行以下步骤。

1. 使用选定的 Motion task brief 创建工程。
2. 调用 `openmotion_open_preview(action=begin)` 开始一个 work round。
3. 通过 `record_checkpoint` 记录所需预览和等待用户决定的状态。
4. 在需要时尝试越权动作，验证拦截逻辑。
5. 通过 `openmotion_edit_project` 保存实际的 native HTML composition。
6. 通过 `complete_generation` 标记 production 完成。
7. 通过 `openmotion_export_request` 和本地 render worker 排队并执行 MP4 导出。
8. 使用 `includeVideo=true` 读取 work round，验证导出媒体可播放。
9. 收集 work round 状态、版本身份、导出状态、媒体大小、SHA-256 和不包含内容的结构化 telemetry。

端到端 runner 使用了 MCP runtime 的同一套 `Phase1Service`、native project versioning、request journal、work-round persistence、export worker 和 media readback 路径，没有用纯状态机函数调用替代服务链路。

## 端到端结果

| Task | Project ID | Work ID | 预览数 | 最终 checkpoint records | 导出 | 可播放 | 结果 |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| `motion_001` | `f7b49ffc-8ed0-49fb-bb82-6638e2061cc5` | `e2561430-110d-4bd5-8baa-65892a3ec4dc` | 3 | preview、select、motion sample、confirm、production、redesign、motion sample、confirm、production | completed | 是 | 通过 |
| `motion_014` | `a0b9eb7f-cae9-473f-83ec-7c4e4e731244` | `01e3f13f-0591-4ee4-9de2-a59b17ec3c9f` | 1 | preview、confirm、production | completed | 是 | 通过 |
| `motion_029` | `8251d25b-4d21-4376-943f-ed156ece46e4` | `1819f286-01ca-4b21-b0fc-3899bccf99e1` | 0 | skipped、production | completed | 是 | 通过 |
| `motion_037` | `ad789e9d-4932-4634-b313-d156b23bb621` | `bb163b12-8c21-41ef-b6b8-98b53c03a387` | 0 | 没有 checkpoint records | completed | 是 | 通过 |
| `motion_002` | `f4b72a3f-b953-40e1-b42f-0449985d77b6` | `7d05aecc-6f35-4fe6-bfc0-23825e55c7ce` | 2 | preview、revision、preview、switch、select、production | completed | 是 | 通过 |

导出媒体证据如下。

| Task | 字节数 | SHA-256 |
| --- | ---: | --- |
| `motion_001` | 40,294 | `35b68f85a0c90c4897d9bb18877b5fcb9be1b79982354356ed11e6aa211fa315` |
| `motion_014` | 37,433 | `64300a0c03c99da6a1fd2038bd5d7480ac998172ad3758a1d441af02b489a481` |
| `motion_029` | 41,452 | `addb2c7d5f412733165f61ad0f07ff841848d803efdbec848c37558c46f81561` |
| `motion_037` | 45,355 | `1d258fa2826ede670449a3ed860bfe7536322944841253a60655962fea081d07` |
| `motion_002` | 37,740 | `c33be64dbfa7aa0df5f36caa157447de33c9e6d189e34c634d96528495834171` |

## 边界验证

### 高风险 motion 路径

`motion_001` 记录了两个 `motionRisk=high` 的创意方向。选择其中一个方向后，状态进入 `previewing`，并要求提供 `motion_sample`。尝试提交 storyboard 时返回 `INVALID_ARGUMENT`。确认前导出时返回 `CREATIVE_CONFIRMATION_REQUIRED`。

第一次 production start 后提交 `motion_or_audio` 重设计，work round 回到 `previewing`。重新生成 motion sample 并确认后，状态回到 production。同一个 work round 产生了两次 `production_started`，第二次事件带有更新后的 preview version 和 `revision_count=1`。

### 低风险路径

`motion_014` 使用一个 storyboard candidate。只有在明确确认后，状态才从 `waiting_user` 进入 `confirmed`。记录 `production_started` 是 generation completion 和正式导出的前置条件。

### 跳过路径

`motion_029` 使用允许的 `simple_template_adaptation` skip reason。跳过后 work round 进入 `confirmed`，但在记录 `production_started` 前，`complete_generation` 仍会被拦截。

### 向后兼容

`motion_037` 没有任何 `creative` checkpoint 数据，仍通过原有 work-round 路径完成 generation completion 和导出。

### 修订、已保存版本和请求重放

`motion_002` 记录了一次 revision request，创建第二个预览，切换回第一个已保存预览，选择该预览并开始 production。使用同一个 request ID 重复提交第一个预览请求时返回 `replayed=true`，没有追加重复的 checkpoint record。

## Telemetry 结果

隔离运行记录了 4 类 checkpoint telemetry 事件，数量如下。

| Event | 数量 | 覆盖情况 |
| --- | ---: | --- |
| `preview_generated` | 6 | 3 个高风险 motion preview、1 个 storyboard、2 个方向预览版本。 |
| `preview_selected_or_confirmed` | 5 | 高风险方向选择和确认、storyboard 确认、修订后的方向选择。 |
| `preview_revision_requested` | 2 | 1 次预览阶段视觉修订、1 次 production 阶段 motion/audio 重设计。 |
| `production_started` | 5 | 每条 checkpoint 场景各 1 次，另包含高风险重设计后的第二次事件。 |

Telemetry properties 只包含受限枚举、数量、索引、preview version、work ID 和 project ID。checkpoint 事件中没有预览内容、prompt 文本、文件内容或媒体字节。

## 验证结果

定向回归测试通过 19 项，0 项失败。

```text
node --experimental-strip-types --test \
  tests/creative-checkpoint.test.ts \
  tests/inline-video.test.ts \
  tests/work-generation.test.ts \
  tests/inline-video-runtime.test.ts

19 passed, 0 failed
```

完整仓库测试共运行 1,065 项，其中 1,052 项通过、12 项失败、1 项跳过。失败项与本次 checkpoint 实现无关，当前检查发现的原因是仓库媒体文件或 LFS 内容缺失。

- `docs/readme/brand-hero.ja.jpg` 缺失，导致 distribution/package fixture 测试失败。
- `docs/readme/live-templates/descript-create-social-clips.gif` 缺失。
- npm package 测试未获取 `source/assets/lfs/original-soundtrack.m4a`。
- host Python helper 测试因缺少 NumPy 和 OpenCV 被跳过。

此前已完成的边界检查也通过，包括 backend typecheck、Studio typecheck、repository check、design-system check、Studio build 和相关确定性测试。

## 限制

本实验验证的是本地 checkpoint workflow 和真实的本地 generation/export 链路。它没有验证完整 Motion brief 的视觉质量、外部参考视频相似度、附件还原度、模型质量、音频质量或人工验收。这些内容需要对应的 Motion 附件、provider 和人工视觉检查。

本次运行数据保存在仓库之外的系统临时目录中。报告记录了 project ID 和 work ID，临时数据仍存在时可据此关联原始运行记录。
