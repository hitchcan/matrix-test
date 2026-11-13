const object={type:'object',additionalProperties:false};
const seconds={type:'integer',minimum:0};
const templateSpec={...object,required:['topic','style','facts','targets','assetIds','mode'],properties:{
  taskMode:{type:'string',enum:['generate','direct','select']},assetRange:{...object,type:['object','null'],required:['from','to'],properties:{from:{type:'string',format:'date'},to:{type:'string',format:'date'}}},topic:{type:'string',maxLength:500},style:{type:'string',maxLength:2000},facts:{type:'string',maxLength:16000},
  targets:{type:'array',minItems:1,maxItems:32,items:{...object,required:['accountId','type'],properties:{
    accountId:{type:'string'},type:{type:'string',enum:['article','note','video']},style:{type:'string'}}}},
  assetIds:{type:'array',maxItems:100,items:{type:'string'}},assetNotes:{type:'object',additionalProperties:{type:'string'}},
  webResearch:{type:'boolean'},maxSearchRequests:{type:'integer',minimum:1,maximum:8},editorialReview:{type:'boolean'},reviewBeforePublish:{type:'boolean'},imageSearch:{...object,properties:{enabled:{type:'boolean'},useReferenceImages:{type:'boolean'},maxImages:{type:'integer',minimum:1,maximum:4}}},videoModelId:{type:['string','null'],maxLength:100},generationModelId:{type:['string','null'],maxLength:100},sourceMode:{type:'string',enum:['description','content']},douyinVisibility:{type:['string','null'],enum:['public','private',null]},mode:{type:'string',enum:['manual','auto']},useImageText:{type:'boolean'},noteCard:{type:'boolean'},
  videoAspect:{type:'string',enum:['portrait','landscape']},maxCalls:{type:'integer',minimum:0,maximum:32},
  maxMicros:{type:['integer','null'],minimum:0},assetCooldownSeconds:seconds,
  schedule:{...object,properties:{kind:{type:'string',enum:['manual','once','interval','daily','weekly','monthly']},endAt:{type:['string','null'],format:'date-time'},times:{type:'array',maxItems:24,items:{type:'string'}},weekdays:{type:'array',items:{type:'integer',minimum:0,maximum:6}},monthDays:{type:'array',items:{type:'integer',minimum:1,maximum:31}},timezone:{type:'string'},startAt:{type:['string','null'],format:'date-time'},
    intervalSeconds:seconds,prepareLeadSeconds:seconds,latePolicy:{type:'string',enum:['latest','skip']}}},
  publicationPolicy:{...object,properties:{
    recovery:{...object,properties:{enabled:{type:'boolean'},visualEnabled:{type:'boolean'},structuredCallsBeforeVisual:{type:'integer',minimum:1,maximum:32},maxRoundsPerIncident:seconds,maxActionsPerIncident:seconds,maxIncidentDurationSeconds:seconds}},
    verification:{...object,properties:{enabled:{type:'boolean'},firstCheckAfterSeconds:seconds,checkIntervalSeconds:seconds,
      absenceWindowSeconds:seconds,requiredValidChecks:seconds,lastCheckFreshnessSeconds:seconds,maxObserveDurationSeconds:seconds}},
    retry:{...object,properties:{maxResends:seconds,allowAbsentAfterTimeout:{type:'boolean'},cooldownSeconds:{type:'array',items:seconds},retryDeadlineSeconds:seconds}}
  }}
}};
export function workflowTools({macros,publicationAction,getIntent,context}) {
  const tools=[
    {name:'context',description:'读取可用账号、素材和工作流能力',inputSchema:{...object,properties:{}}},
    {name:'templates',description:'读取已保存模板',inputSchema:{...object,properties:{}}},
    {name:'save_template',description:'保存任务模板；已有模板需 expectedVersion',inputSchema:{...object,required:['spec','enabled'],properties:{id:{type:'string'},expectedVersion:{type:'integer'},enabled:{type:'boolean'},spec:templateSpec}}},
    {name:'delete_template',description:'删除已保存任务并停止后续定时创建，保留既有运行及分发记录',inputSchema:{...object,required:['id','expectedVersion'],properties:{id:{type:'string'},expectedVersion:{type:'integer'}}}},
    {name:'run_template',description:'用 requestKey 幂等创建一次运行',inputSchema:{...object,required:['id','requestKey'],properties:{id:{type:'string'},requestKey:{type:'string'}}}},
    {name:'run',description:'读取运行成品、目标与发布状态',inputSchema:{...object,required:['id'],properties:{id:{type:'string'}}}},
    ...['edit_artifact','revise_artifact','approve_artifact'].map(name=>({name,description:'编辑、交主agent审改或确认尚未分发的待审图文，校验稿件版本',inputSchema:{...object,required:['id','targetId','expectedRevision'],properties:{id:{type:'string'},targetId:{type:'string'},expectedRevision:{type:'integer'},...(name==='edit_artifact'?{title:{type:'string'},blocks:{type:'array',items:{type:'object'}}}:name==='revise_artifact'?{feedback:{type:'string'}}:{})}}})),
    {name:'resume_target',description:'恢复同一运行中可安全重试的阻断目标',inputSchema:{...object,required:['id','targetId'],properties:{id:{type:'string'},targetId:{type:'string'}}}},
    {name:'stop_run',description:'停止尚未分发的目标',inputSchema:{...object,required:['id'],properties:{id:{type:'string'}}}},
    {name:'publication',description:'读取发布账本与当前版本',inputSchema:{...object,required:['id'],properties:{id:{type:'string'}}}},
    ...['verify','recover','request-retry','human-completed','stop'].map(name=>({name,description:'对原发布任务执行 '+name+'，服从阶段、版本、预算与提交门禁',
      inputSchema:{...object,required:['id','expectedVersion'],properties:{id:{type:'string'},expectedVersion:{type:'integer'}}}}))
  ];
  function invoke(name,args={}) {
    const tool=tools.find(t=>t.name===name);
    if(!tool || !args || typeof args!=='object' || Array.isArray(args) ||
        Object.keys(args).some(k=>!Object.hasOwn(tool.inputSchema.properties,k)) ||
        (tool?.inputSchema.required||[]).some(k=>!Object.hasOwn(args,k)))
      throw Object.assign(Error('未知工作流工具或参数无效'),{status:422,reasonCode:'invalid_tool_input'});
    for(const [key,value] of Object.entries(args)) {
      const type=tool.inputSchema.properties[key].type;
      if((type==='integer'&&!Number.isSafeInteger(value)) || (type==='array'?!Array.isArray(value):type!=='integer'&&typeof value!==type) || value===null)
        throw Object.assign(Error('工具参数类型无效'),{status:422,reasonCode:'invalid_tool_input'});
    }
    switch(name) {
      case 'context':return context();
      case 'templates':return macros.templates();
      case 'save_template':return macros.save(args,args.id,!!args.id);
      case 'delete_template':return macros.remove(args.id,args.expectedVersion);
      case 'run_template':return macros.runNow(args.id,args.requestKey);
      case 'run':return macros.details(args.id);
      case 'edit_artifact':case 'revise_artifact':case 'approve_artifact':return macros.reviewTarget(args.id,args.targetId,args,{edit_artifact:'edit',revise_artifact:'revise',approve_artifact:'approve'}[name]);
      case 'resume_target':return macros.resumeTarget(args.id,args.targetId);
      case 'stop_run':return macros.stopRun(args.id);
      case 'publication': {
        const value=getIntent(args.id);
        if(!value)throw Object.assign(Error('发布任务不存在'),{status:404,reasonCode:'not_found'});
        return value;
      }
      default:return publicationAction(args.id,name,{expectedVersion:args.expectedVersion});
    }
  }
  function execute(name,args) {
    try {return invoke(name,args);}
    catch(error) {
      if(error.reasonCode)throw error;
      const status=error.status||500;
      const codes={404:'not_found',409:'version_or_state_conflict',422:'validation_failed'};
      throw Object.assign(Error(status===500?'工作流操作未完成':error.message),{status,reasonCode:codes[status]||'operation_failed'});
    }
  }
  return {list:()=>structuredClone(tools),execute};
}
