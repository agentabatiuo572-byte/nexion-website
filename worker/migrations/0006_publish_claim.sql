-- 发布锁补三列(2026-09-01 复验 P0-A / P1-B)。
--
-- claim_nonce:本次发布的一次性口令。服务端发起发布时生成,只经 /api/publish/next 交给执行器;
--   执行器把它写进线上快照的 .publish-stamp.json,服务端标 live 前回读核实。
--   为什么需要:此前服务端**信执行器的汇报**,于是按顺序把四步各报一遍就能让版本上线而一道门没跑
--   (伪造出的痕迹与真发布完全同形)。现在改成**服务端核实结果**——印记要落进文件系统才算数,
--   纯 HTTP 调用者写不进去。nonce 让印记绑定到「这一次发布」,旧快照里的陈年印记也顶不了账。
--
-- claimed_at / claimed_by:执行器领单的原子占位。此前判「已有步骤记录就不再派发」只挡得住**先后**,
--   挡不住**同时**——两个执行器一起启动就是同一个 3 秒节拍,实测两次并发 /next 领到同一单。
--   改用条件更新 (WHERE claimed_at IS NULL) 原子占位:同时到达也只有一个能拿到。
ALTER TABLE publish_lock ADD COLUMN claim_nonce TEXT;
ALTER TABLE publish_lock ADD COLUMN claimed_at INTEGER;
ALTER TABLE publish_lock ADD COLUMN claimed_by TEXT;
