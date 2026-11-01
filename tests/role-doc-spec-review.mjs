// Design-level consistency and scenario review only. Does NOT test the backend implementation.
import fs from 'node:fs';
import cp from 'node:child_process';

const read = f => fs.readFileSync(f, 'utf8');
const d = read('开发AI.md'), q = read('独立测试AI.md'), c = read('总控AI.md'), w = read('WORKFLOW.md');
const pl = read('data/taskboard/plans/WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1.md');
const parent = read('tests/fixtures/role-doc-selftest/WTB-P1-UNIVERSAL-SOFTWARE-WORKFLOW-TEMPLATE-20261031-T1.md');
const checks = [];
function check(name, condition) { checks.push({ name, pass: !!condition }); }

check('手动唤醒边界', d.includes('手动唤醒') && q.includes('手动唤醒'));
check('角色必须读取实时任务事件', d.includes('get/history/guard') && q.includes('get/history/guard'));
check('多名开发可并行', d.includes('开发AI-A执行任务A、开发AI-B执行任务B') && c.includes('开发AI-A、开发AI-B'));
check('单开发只能一个活跃任务', d.includes('不能创建第二个认领') && pl.includes('一个开发AI自身只能一个进行中任务'));
check('开发完成一项先报告再下一项', d.includes('每任务结束先汇报再下一个'));
check('本任务Job未结束不得切换', d.includes('先完成在手任务，不能交错'));
check('各开发actor和Session/worktree隔离', d.includes('不同开发AI的独立actor-id／Session') && d.includes('独立Git worktree'));
check('确定性排序', d.includes('任务ID字典序') && q.includes('任务ID字典序'));
check('同级合法待办不得全部阻断', pl.includes('同级两个合法待办时稳定选一个') && !pl.includes('两个待办只能拒绝自动抢占'));
check('有歧义的身份才阻断', d.includes('任务所有权/项目身份或用户授权无法分辨') && q.includes('可信归属消歧'));
check('检测文件和共享契约冲突', d.includes('共享数据库/schema') && d.includes('API契约'));
check('其他开发无冲突任务不产生全局锁', d.includes('如果不占同一不可隔离资源且调度容量允许'));
check('所有开发交一个QA', q.includes('单独一个独测AI统一接收所有开发AI的候选'));
check('QA跨所有授权项目扫描', q.includes('所有已注册且本QA被授权项目') && pl.includes('跨项目单QA统一队列'));
check('QA按项目ID+任务ID识别', q.includes('项目ID + 任务ID') && parent.includes('项目ID+任务ID'));
check('QA跨项目全局只能一个Attempt', q.includes('跨项目全局互斥') && pl.includes('全局只有一个QA执行中Attempt'));
check('QA FAIL A后可测B', q.includes('QA完成正式FAIL交接后可继续开发AI-B'));
check('QA先结果交接再测下一候选', q.includes('独测结束即报告、释放、再选'));
check('各开发证据不混用', q.includes('开发者A的PASS') && q.includes('开发者B'));
check('QA不能与开发同actor及Session', q.includes('同时不同于原开发 AI'));
check('main合并串行且远端前移重新核验', d.includes('远端main只能按受控顺序交付') && pl.includes('候选版本必须重新核验'));
check('开发需要用户明确授权接管', d.includes('用户明确授权优先于旧Session占用'));
check('QA需要用户明确授权接管', q.includes('异常接管独测'));
check('单纯继续不构成接管授权', d.includes('继续”**不等于授权接管') && q.includes('普通“继续”不得自动抢占'));
check('授权须从可信用户交互核验', d.includes('AI不得仅凭自己向API正文') && q.includes('不能凭QA自己在请求体'));
check('接管授权绑定任务版本时效', d.includes('授权版本') && pl.includes('授权版本/时效'));
check('接管后旧Session失权', d.includes('旧Session失去该任务后续claim') && q.includes('旧Session恢复在线不得继续'));
check('旧dirty ignored成果保全', d.includes('dirty/untracked/ignored'));
check('接管不能继承不适用PASS', d.includes('旧PASS跳过QA') && q.includes('未完整结束的PASS'));
check('不支持接管时不能强制PATCH', d.includes('不得绕过状态机直接PATCH强改') && q.includes('强制PATCH'));
check('不自动唤醒其他AI', c.includes('不自动唤醒') && w.includes('用户明确命令异常接管'));
check('总控先审流程后报告', c.includes('第一部分【流程检查结果】') && c.includes('第二部分【实际进度与问题】') && c.includes('第三部分【下一步安排】'));
check('每个空闲开发AI可各有一个当前任务', c.includes('每个空闲且有合法候选的开发AI仅安排一个当前任务'));
check('旧唯一待办阻断条款已删除', !pl.includes('其他唯一合法待开发任务') && !pl.includes('发现多个同级候选时，只返回'));
check('旧哈希指令已清理', !pl.includes('49681955027543b6dec4bf686ced687f85d10981db4d3f345d8af4781e664feb'));
check('根角色文件在正式writeTargets', pl.includes('已列入本任务正式writeTargets'));
check('P1父任务包括跨项目QA展示', parent.includes('跨项目UI复测'));
check('通用工作流覆盖并行QA接管', w.includes('多AI调度和异常接管原则') && w.includes('跨项目统一队列'));
const ids = ['WTB-P0-DELIVERY-TAKEOVER-20261031-T1', 'WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1', 'WTB-P1-UNIVERSAL-SOFTWARE-WORKFLOW-TEMPLATE-20261031-T1'];
const live = ids.map(id => {
  const z = cp.spawnSync('node', ['cli/taskctl.mjs', 'get', '--project', 'wyerp-taskboard', '--task', id], {encoding:'utf8'});
  if (z.status !== 0) throw Error(z.stderr);
  const t = JSON.parse(z.stdout);
  return {id, status:t.status};
});
check('已完成P0解锁子P1但父P1仍HOLD', live[0].status === '已完成' && ['待开发','开发中','修复中','待独测','独测中','待复测','复测中','待交付','交付中','已完成'].includes(live[1].status) && live[2].status === 'HOLD');
check('Markdown围栏成对', [d,q,c,w,pl,parent].every(s => (s.match(/^\x60{3}/gm) || []).length % 2 === 0));

// This reference model specifies expected behavior for review of the future implementation.
// It is not run against an implemented scheduler.
function mayStartDev({sameActorActive=false, otherActorActive=false, conflict=false, eligible=true}) {
  return eligible && !sameActorActive && !(otherActorActive && conflict);
}
function mayStartQa({qaActive=false, jobActive=false, candidateValid=true, authorized=true}) {
  return !qaActive && !jobActive && candidateValid && authorized;
}
function mayTakeover({trustedApproval=false, currentOwnerFenced=false, evidenceValid=true}) {
  return trustedApproval && currentOwnerFenced && evidenceValid;
}
function mayReusePass({shaSame=true, reportValid=true}) {
  return shaSame && reportValid;
}
const scenarios = [
  ['开发A执行时开发B做独立任务', mayStartDev({otherActorActive:true, conflict:false}) === true],
  ['同开发AI同时接第二任务', mayStartDev({sameActorActive:true}) === false],
  ['跨开发者写相同文件阻断', mayStartDev({otherActorActive:true, conflict:true}) === false],
  ['前置依赖未通过阻断', mayStartDev({eligible:false}) === false],
  ['一QA空闲时可测候选', mayStartQa({}) === true],
  ['QA已认领A不能同时认领B', mayStartQa({qaActive:true}) === false],
  ['QA仍有未结束Job不重复测试', mayStartQa({jobActive:true}) === false],
  ['SHA或报告无效的候选拒测', mayStartQa({candidateValid:false}) === false],
  ['未授权项目候选不进入QA', mayStartQa({authorized:false}) === false],
  ['无用户授权不得接管', mayTakeover({currentOwnerFenced:true}) === false],
  ['授权但旧执行权没隔离时先阻断', mayTakeover({trustedApproval:true}) === false],
  ['可信授权与旧Session失权后可受控接管', mayTakeover({trustedApproval:true, currentOwnerFenced:true}) === true],
  ['接管不能绕过证据失败', mayTakeover({trustedApproval:true, currentOwnerFenced:true, evidenceValid:false}) === false],
  ['新候选SHA不得复用旧PASS', mayReusePass({shaSame:false}) === false],
  ['空白报告不得复用PASS', mayReusePass({reportValid:false}) === false]
];
const failed = checks.filter(x=>!x.pass);
const simFail = scenarios.filter(x=>!x[1]);
const output = {kind:'Design/static consistency + reference scenarios only; NOT deployed server QA',static:{passed:checks.length-failed.length,total:checks.length,failures:failed.map(x=>x.name)},scenarios:{passed:scenarios.length-simFail.length,total:scenarios.length,failures:simFail.map(x=>x[0])},live};
console.log(JSON.stringify(output,null,2));
if(failed.length || simFail.length) process.exit(2);
