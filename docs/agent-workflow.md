# Agent Automation Workflow

縺薙・繝ｪ繝昴ず繝医Μ縺ｧ縺ｯ縲，laude Code 繧貞ｮ溯｣・球蠖薙，odex 繧呈欠遉ｺ繝ｻ繝ｬ繝薙Η繝ｼ諡・ｽ薙→縺励※菴ｿ縺・・
## 謗ｨ螂ｨ繝輔Ο繝ｼ

1. Codex 縺悟次蝗蛻・梵縺ｨ Claude Code 縺ｸ縺ｮ菴懈･ｭ謖・､ｺ繧剃ｽ懊ｋ縲・2. `scripts/agent-loop.ps1` 縺・Claude Code CLI 繧帝撼蟇ｾ隧ｱ螳溯｡後☆繧九・3. 繧ｹ繧ｯ繝ｪ繝励ヨ縺・JSON / JavaScript 讒区枚繝√ぉ繝・け縺ｨ `git diff --check` 繧貞ｮ溯｡後☆繧九・4. Codex CLI 縺梧悴繧ｳ繝溘ャ繝亥ｷｮ蛻・ｒ繝ｬ繝薙Η繝ｼ縺励～PASS` 縺ｾ縺溘・ `REVISE` 繧定ｿ斐☆縲・5. `REVISE` 縺ｮ蝣ｴ蜷医√Ξ繝薙Η繝ｼ蜀・ｮｹ繧・Claude Code 縺ｫ貂｡縺励※蜀堺ｿｮ豁｣縺吶ｋ縲・6. 譛螟ｧ隧ｦ陦悟屓謨ｰ縺ｫ驕斐☆繧九°縲～PASS` 縺ｫ縺ｪ縺｣縺滓凾轤ｹ縺ｧ蛛懈ｭ｢縺吶ｋ縲・
## hook 縺ｮ菴ｿ縺・婿

Codex hook 縺ｯ `.codex/hooks.json` 縺ｫ險ｭ螳壹＠縺ｦ縺・ｋ縲る壼ｸｸ縺ｯ菴輔ｂ縺励↑縺・・
閾ｪ蜍募喧繝ｫ繝ｼ繝励ｒ hook 邨檎罰縺ｧ襍ｷ蜍輔＠縺溘＞蝣ｴ蜷医□縺代∵ｬ｡縺ｮ繧ｳ繝槭Φ繝峨〒繝輔Λ繧ｰ繧剃ｽ懊ｋ縲・
```powershell
.\scripts\start-agent-loop.ps1
```

縺昴・蠕後，odex 縺ｮ繧ｿ繝ｼ繝ｳ縺檎ｵゆｺ・＠縺溘ち繧､繝溘Φ繧ｰ縺ｧ hook 縺・`scripts/agent-loop.ps1` 繧偵ヰ繝・け繧ｰ繝ｩ繧ｦ繝ｳ繝芽ｵｷ蜍輔☆繧九・
蛻晏屓縺ｾ縺溘・ hook 螟画峩蠕後・縲，odex 蛛ｴ縺ｧ `/hooks` 繧帝幕縺阪√・繝ｭ繧ｸ繧ｧ繧ｯ繝・hook 繧剃ｿ｡鬆ｼ縺吶ｋ蠢・ｦ√′縺ゅｋ縲・
## 逶ｴ謗･螳溯｡・
hook 繧剃ｽｿ繧上★縺ｫ逶ｴ謗･螳溯｡後☆繧句ｴ蜷・

```powershell
.\scripts\agent-loop.ps1 -TaskFile docs\agent-tasks\shift-alt-u-shortcut.md -MaxIterations 3
```

## 螳牙・險ｭ險・
- 閾ｪ蜍・push 縺ｯ繝・ヵ繧ｩ繝ｫ繝育┌蜉ｹ縲・- 閾ｪ蜍・commit 繧ゅョ繝輔か繝ｫ繝育┌蜉ｹ縲・- hook 縺ｯ `.codex/run-agent-loop.flag` 縺後↑縺・剞繧願ｵｷ蜍輔＠縺ｪ縺・・- 繝ｭ繧ｰ縺ｯ `.codex/agent-loop/` 縺ｫ蜃ｺ蜉帙＠縲；it 縺ｫ縺ｯ蜷ｫ繧√↑縺・・
