const stopWords=new Set('a an and are as at be can could do for from help how i in into is it me my of on or please the to want with would why you'.split(' '));

function words(text){
 return (text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]);
}

function matches(term,word){
 return term===word || (Math.min(term.length,word.length)>=3 && (word.startsWith(term)||term.startsWith(word)));
}

export function searchWorkflows(workflows,query,limit=5){
 if(typeof query!=='string'||!query.trim()||query.length>200)throw new Error('workflow query must contain 1-200 characters');
 if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error('workflow search limit must be an integer from 1 to 20');
 const terms=[...new Set(words(query).filter(word=>!stopWords.has(word)))];
 if(!terms.length)throw new Error('workflow query needs searchable words');
 const ranked=[];
 for(const workflow of workflows){
  const nameWords=words(workflow.name);
  const metadataWords=words([workflow.description,...workflow.arguments.map(arg=>`${arg.name} ${arg.description}`)].join(' '));
  const matchedTerms=terms.filter(term=>[...nameWords,...metadataWords].some(word=>matches(term,word)));
  if(!matchedTerms.length)continue;
  const nameMatches=terms.filter(term=>nameWords.some(word=>matches(term,word))).length;
  const exact=words(workflow.name).join(' ')===words(query).join(' ');
  ranked.push({workflow,matchedTerms,score:matchedTerms.length*100+nameMatches*10+(exact?10000:0)});
 }
 ranked.sort((a,b)=>b.score-a.score||(a.workflow.name<b.workflow.name?-1:a.workflow.name>b.workflow.name?1:0));
 return {query:query.trim(),terms,totalMatches:ranked.length,limit,truncated:ranked.length>limit,
  workflows:ranked.slice(0,limit).map(({workflow,matchedTerms})=>({...workflow,matchedTerms}))};
}
