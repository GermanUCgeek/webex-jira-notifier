// jira-event.js
//
// An object for checking if Jira Events are relevant to Spark users who are
// in a room with our bot
/*jshint esversion: 6 */  // Help out our linter

// When running locally read environment variables from a .env file
require('dotenv').config();
logger = require('./logger');

// Only allow users for our email organization user the bot
let request = null;
let basicToken = '';
let jira_url = '';
let proxy_url = '';
let jira_url_regexp = null;
if (process.env.JIRA && process.env.JIRA_URL) {
  // for finding watchers
  request = require('request-promise');
  basicToken = process.env.JIRA;
  jira_url = process.env.JIRA_URL;
  if (process.env.PROXY_URL) {
    // Set variables to get watcher info via a server
    jira_url_regexp = new RegExp(jira_url);
    proxy_url = process.env.PROXY_URL;
    logger.info('Will attempt to access Jira via proxy at ' + jira_url);
  }
} else {
  logger.error('Cannot read Jira credential.  Will not notify watchers');
}

const JIRA_PROJECTS = process.env.JIRA_PROJECTS;
const jiraProjects = JIRA_PROJECTS.split(',');

//Determine which event we have.  If its one we care about see if it belongs
// to someone in a room with our bot
exports.processJiraEvent = function (jiraEvent, framework, emailOrg, callback=null) {
  //logJiraEvent(jiraEvent);
  try {
    // We'll build a list of users who are mentioned or assigned
    let toNotifyList = [];
    // We'll also notify any watchers of this change 
    //(but only once even if multiple things changed)
    jiraEvent.watchersNotified = false;

    // Is this from one of the proejcts we can access?
    // jiraEvent.ourProjectIdx == -1 means no.
    const key = jiraEvent.issue.key;
    // Debug a particiular story
    // if (key == 'SPARK-7329') {
    //   console.log('Found the one I want to debug.');
    // }
    jiraEvent.ourProjectIdx = jiraProjects.indexOf(key.substr(0, key.indexOf('-')));
    if (jiraEvent.ourProjectIdx == -1) {
      logger.verbose('Got a webhook for '+ key + 
        '. Not in our list of projects: ' + JIRA_PROJECTS);
    }

    if ((jiraEvent.webhookEvent === 'jira:issue_updated') &&
        (((jiraEvent.issue_event_type_name === 'issue_commented') ||
        (jiraEvent.issue_event_type_name === 'issue_comment_edited')) ||
        ((jiraEvent.issue_event_type_name === 'issue_updated') &&
        (typeof jiraEvent.comment === 'object')))) {
      toNotifyList = getAllMentions(jiraEvent.comment.body);
      notifyPeople(framework, jiraEvent, toNotifyList,  // extract mentions
        jiraEvent.comment.author.displayName,
        ' mentioned you in the Jira ', '', '',
        jiraEvent.comment.body, emailOrg, callback);
    } else if ((jiraEvent.webhookEvent === 'jira:issue_updated') &&
              (jiraEvent.issue_event_type_name === 'issue_updated') || 
              (jiraEvent.issue_event_type_name === 'issue_work_started') || 
              (jiraEvent.issue_event_type_name === 'issue_assigned')) {
      // Loop through the changed elements to see if one was that assignation
      if ((!jiraEvent.changelog) || (!jiraEvent.changelog.items.length)) {
        logger.error('Expected a changelog for %s:%s but did not find one!' +
          ' No one will be notified', jiraEvent.webhookEvent, 
        jiraEvent.issue_event_type_name);
        createTestCase(null, jiraEvent, 'no-changelog');   
        if (callback) {callback(e);}
        return;     
      }
      for (var i = 0, len = jiraEvent.changelog.items.length; i < len; i++) {
        var item = jiraEvent.changelog.items[i];
        logger.debug('Looking at changlong issue:', i);         
        if (item.field === 'assignee') {
          // See if the user was assigned to this existing ticket
          toNotifyList.push(item.to);
          notifyPeople(framework, jiraEvent, toNotifyList, jiraEvent.user.displayName, //single user
            ' assigned existing Jira ', ' to you.', 'Description:',
            jiraEvent.issue.fields.description, emailOrg, callback);
        } else if (item.field === 'description') {
          // If data was added TO the description see if there are any mentions
          if (item.toString) {
            toNotifyList = getAllMentions(item.toString);
            if (toNotifyList.length) {
              notifyPeople(framework, jiraEvent, toNotifyList,  // extract mentions
                jiraEvent.user.displayName,
                ' updated the description of Jira ', ' to you.',
                'Description:', item.toString, emailOrg, callback);  
            } else {
              if (callback) {callback(null);}
              return notifyWatchers(framework, jiraEvent, toNotifyList, jiraEvent.user.displayName, callback);
            }
          } else {
            logger.debug('Ignoring delete only update to Description for Jira Event:' + jiraEvent.webhookEvent);
            if (callback) {callback(null);}
            return notifyWatchers(framework, jiraEvent, toNotifyList, jiraEvent.user.displayName, callback);
          } 
        } else {
          logger.debug('No assignees or mentionees to notify for a change to %s, '+
            'will look for watchers.', item.field);                   
          if (callback) {callback(null);}
          return notifyWatchers(framework, jiraEvent, toNotifyList, jiraEvent.user.displayName, callback);
        }
      }
    } else if ((jiraEvent.webhookEvent === 'jira:issue_created') &&
          (jiraEvent.issue_event_type_name === 'issue_created')) {
      // This assignee logic is based on a manufactured payload. Should create new test cases when we can
      // Assign users in the create dialog
      if (jiraEvent.issue.fields.assignee) {   
        // Jira webhook payload seems to populate assignee differently on different projects...
        if (jiraEvent.issue.fields.assignee.name) {
          toNotifyList.push(jiraEvent.issue.fields.assignee.name);     
        } else {
          toNotifyList.push(jiraEvent.issue.fields.assignee);
        }
        notifyPeople(framework, jiraEvent, toNotifyList,  //one name
          jiraEvent.user.displayName,
          ' created a Jira ', ' and assigned it to you.',
          'Description:', jiraEvent.issue.fields.description, 
          emailOrg, callback);
      }
      if (jiraEvent.issue.fields.description) {
        // See if the user was assigned to this existing ticket
        toNotifyList = getAllMentions(jiraEvent.issue.fields.description);
        notifyPeople(framework, jiraEvent, toNotifyList,  // extract mentions
          jiraEvent.user.displayName,
          ' created a Jira ', ' and mentioned to you in it.',
          'Description:', jiraEvent.issue.fields.description, 
          emailOrg, callback);
      }
    } else if (jiraEvent.webhookEvent === 'jira:issue_deleted') {
      if (!jiraEvent.issue.fields.assignee.name) {
        logger.error('Got an issue deleted with no assignee');
        e = new Error('DeletedWithNoAssignee');
        createTestCase(e, jiraEvent, 'no-assignee');
        notifyWatchers(framework, jiraEvent, [],  //no one was "notified"
          jiraEvent.user.displayName, callback);
        if (callback) {(callback(e));}
        return;
      }
      // Someone deleted a ticket that was assigned to the user
      toNotifyList.push(jiraEvent.issue.fields.assignee.name);
      notifyPeople(framework, jiraEvent, toNotifyList,  //one name
        jiraEvent.user.displayName,
        ' deleted a Jira ', ' that was assigned to you.',
        'Description:', jiraEvent.issue.fields.description, 
        emailOrg, callback);
    } else {
      logger.debug('No notifications for Jira Event '+jiraEvent.webhookEvent+
        ':'+jiraEvent.issue_event_type_name+'. Checking for watchers...');
      if (callback) {(callback(null, null));}
      notifyWatchers(framework, jiraEvent, [],  //no one was "notified"
        jiraEvent.user.displayName, callback);
    }
  } catch (e) {
    logger.error('Caught Error in JiraEvent Handler:' + e);
    createTestCase(e, jiraEvent, 'caught-error');
    if (callback) {return(callback(e));}
  }
};

// Check the event against our users.  If we get a hit, send a spark message
function notifyPeople(framework, jiraEvent, notifyList, author, eventName, action, elementName, elementValue, emailOrg, cb) {
  // if (!notifyList.length) {
  //   if (!jiraEvent.watchersNotified) {
  //     logger.verbose('No one to notify for Jira Event:' + jiraEvent.webhookEvent +
  //                 '. Will check for watchers...');
  //     return notifyWatchers(framework, jiraEvent, notifyList, author, cb);
  //   } else {
  //     return;
  //   }
  // }
  notifyList.forEach(function(user) {
    let email = user + '@' + emailOrg;
    let bot = framework.bots.find(function(bot) {return(bot.isDirectTo === email);});
    if (bot) {
      let theBot = bot;
      theBot.recall('userConfig').then(function(userConfig) {
        if (userConfig.askedExit) {
          return logger.info('Supressing message to ' + theBot.isDirectTo);
        }
        sendNotification(framework, theBot, jiraEvent, author, eventName, action, elementName, elementValue, userConfig, cb);
        // Add instrumentation to find users who are not working in the SPARK or TROPO projects
        if (jiraEvent.ourProjectIdx == -1) {
          logger.error(email + ' is working on project ' + jiraEvent.issue.key);
        }
      }).catch(function(err) {
        logger.error('Unable to get quietMode status for ' + theBot.isDirectTo);
        logger.error(err.message);
        logger.error('Erring on the side of notifying them.');
        sendNotification(framework, theBot, jiraEvent, author, eventName, action, elementName, elementValue, null, cb);
      });
    } else {
      logger.verbose('No bot found for potential recipient:' + email);
      // Test framework wants to no if a user who was mentioned or assigned does NOT get a message
      if (cb) {return(cb(null, null));}
    }
  });
  notifyWatchers(framework, jiraEvent, notifyList, author, cb);
}

// Check the event against our watchers.  If we get a hit, send a spark message
function notifyWatchers(framework, jiraEvent, notifyList, author, cb) {
  if (!request) {return;}
  try {
    let jiraKey = jiraEvent.issue ? jiraEvent.issue.key : '';
    if (jiraEvent.watchersNotified) {
      return logger.debug('Already notified potential watchers for %s event %s:%s',
        jiraKey, jiraEvent.issue_event_type_name, jiraEvent.issue_event_type_name);
    }
    if (jiraEvent.ourProjectIdx == -1) {
      return logger.debug('Don\'t have permission to check watchers for %s',
        jiraKey);
    }

    jiraEvent.watchersNotified = true;
    if ((jiraEvent.issue.fields.watches.watchCount) && (jiraEvent.issue.fields.watches.self)) {
      //TODO, process the watcher list
      // Call the watches.self URL to get the list

      // Remove after we parse some data and feel good about all conditions
      let watcherNews = getWatcherNews(jiraEvent);
      let watcherUrl = jiraEvent.issue.fields.watches.self;

      // Use a proxy server if configured
      if (jira_url_regexp) {
        watcherUrl = watcherUrl.replace(jira_url_regexp, proxy_url);
      }
      logger.debug('Looking for watcher info: '+watcherUrl);
      logger.debug('Will send '+watcherNews.description+', changes:'+watcherNews.change);

      request.get(watcherUrl, {
        "json": true,
        headers: {
          'Authorization': 'Basic ' + basicToken
          // If I ever switch to OAuth
          //'bearer' : bearerToken
        }
      }).then(function(resp) {
        if(!resp.hasOwnProperty('watchers')){
          throw new Error('Did not get expected response from Jira watcher lookup.  This usually happens due to login failure and redirection.');
        }
        resp.watchers.forEach(function(watcher) {
          let email = watcher.emailAddress;
          if (notifyList.indexOf(watcher.key) > -1) {
            logger.verbose("Skipping watcher:"+email+". Already notified");
            return;
          }
          let bot = framework.bots.find(function(bot) {return (bot.isDirectTo === email);});
          if (bot) {
            let theBot = bot;
            theBot.recall('userConfig').then(function(userConfig) {
              if ((userConfig.askedExit) || (userConfig.watcherMsgs === false)) {
                return logger.verbose('Supressing message to ' + theBot.isDirectTo);
              }
              watcherNews = (!watcherNews) ? getWatcherNews(jiraEvent) : watcherNews;
              sendNotification(framework, theBot, jiraEvent, author,
                watcherNews.description, ' that you are watching.', 
                "", watcherNews.change, userConfig, cb);
            }).catch(function(err) {
              logger.error('Unable to get quietMode status for ' + theBot.isDirectTo);
              logger.error(err.message);
              logger.error('Erring on the side of notifying them.');
              watcherNews = (watcherNews === {}) ? getWatcherNews(jiraEvent) : watcherNews;
              sendNotification(framework, theBot, jiraEvent, author,
                watcherNews.description, ' that you are watching.', 
                '', watcherNews.change, null, cb);
            });
          } else {
            logger.verbose('No bot found for potential recipient:' + email);
            // Test framework does NOT want to be notified of potential watchers who don't get a message so no callback
          }
        });
      }).catch(function(err) {
        logger.warn('Unable to get any watcher info from %s, :%s',
          jiraEvent.issue.fields.watches.self, err.message);
      });
    } else {
      logger.verbose('No watchers of this issue to notify');
    }
  } catch (err) {
    logger.error('Error processing watchers: '+err.message);
  }
}

// Figure out how to characterize a JiraEvent for the watchers
function getWatcherNews(jiraEvent) {
  let watcherNews = {
    description: ' updated a Jira ',
    change: ''
  };
  //let changedField = '';

  if ((jiraEvent.changelog) && (jiraEvent.changelog.items[0]) && 
        (jiraEvent.changelog.items[0].field)) {
    changedField = jiraEvent.changelog.items[0].field;
  }

  if (jiraEvent.webhookEvent === 'jira:issue_updated') {
    if (jiraEvent.issue_event_type_name === 'issue_commented') {
      watcherNews.description = ' commented on a Jira ';
      watcherNews.change = jiraEvent.comment.body;
    } else if (jiraEvent.issue_event_type_name === 'issue_comment_edited') {
      watcherNews.description = ' uppdated a comment on a Jira ';
      watcherNews.change = jiraEvent.comment.body;
    } else if (jiraEvent.issue_event_type_name === 'issue_comment_deleted') {
      watcherNews.description = ' deleted a comment on a Jira ';
    } else {
      watcherNews.change = getNewsFromChangelong(jiraEvent, watcherNews.change);
    }
  } else if ((jiraEvent.webhookEvent === 'jira:issue_created') &&
    (jiraEvent.issue_event_type_name === 'issue_created')) {
    watcherNews.description = ' created a Jira ';
    watcherNews.change = jiraEvent.issue.fields.description;
  } else if (jiraEvent.webhookEvent === 'jira:issue_deleted') {
    watcherNews.description = ' deleted a Jira ';
    watcherNews.change = jiraEvent.issue.fields.description;
  } else {
    logger.error('Using generic watcherNews for %s:%s_%s', jiraEvent.timestamp, jiraEvent.webhookEvent, jiraEvent.issue_event_type_name);
    createTestCase(null, jiraEvent, 'no-type-handler');
  } 
  return watcherNews;
}

function getNewsFromChangelong(jiraEvent, change) {
  if (!jiraEvent.changelog) {
    let jiraKey = jiraEvent.issue ? jiraEvent.issue.key : '';
    logger.error('No changelong for %s eventtype:%s, issue_type:%s', 
      jiraKey, jiraEvent.issue_event_type_name, jiraEvent.issue_event_type_name);
    createTestCase(null, jiraEvent, 'no-changelog');
    return change;
  };
  for (let i = 0, len = jiraEvent.changelog.items.length; i < len; i++) {
    let item = jiraEvent.changelog.items[i];
    if (item.field) {
      if (change) {change += ', and ';}
      change += 'updated field:'+item.field;
      if ((item.field != 'description') && (item.fromString)) {
        change += ' from:"'+item.fromString+'"';
      }
      if (item.toString) {
        change += ' to:"'+jiraEvent.changelog.items[0].toString+'"';
      }
    }
  }
  if (!change) {
    let jiraKey = jiraEvent.issue ? jiraEvent.issue.key : '';
    logger.error('Unable to find a changed field for %s eventtype:%s, issue_type:%s', 
      jiraKey, jiraEvent.issue_event_type_name, jiraEvent.issue_event_type_name);
    createTestCase(null, jiraEvent, 'no-change');
  }
  return change;
}


// helper function to build a list of all the mentioned users in a description or comment
function getAllMentions(str) {
  let mentionsRegEx = /\[~(\w+)\]/g;
  let mentions = [];
  str.replace(mentionsRegEx, function(match, username) {
    mentions.push(username);
  });
  return mentions;
}

function sendNotification(framework, bot, jiraEvent, author, eventName, action, elementName, elementValue, userConfig, cb) {
  if ((bot.isDirectTo == jiraEvent.user.emailAddress) && 
      ((!userConfig) || (!userConfig.hasOwnProperty('notifySelf')) || (!userConfig.notifySelf))) {
    logger.info('Not sending notification of update made by ' + bot.isDirectTo + ' to ' + jiraEvent.user.emailAddress);
    return;
  }
  logger.info('Sending a notification to '+bot.isDirectTo+' about '+jiraEvent.issue.key);
  let msg =  author + eventName + jiraEvent.issue.fields.issuetype.name +
    ': **' + jiraEvent.issue.fields.summary + '**' + action + '\n\n';

  if ((elementName) || (elementValue)) {
    // Try replacing newlines with <br > to keep all the text in one block
    if (elementName) {
      elementName = elementName.replace(/(?:\r\n\r\n|\r\n|\r|\n)/g, '<br />');
    } 
    if (elementValue) {
      elementValue = elementValue.replace(/(?:\r\n\r\n|\r\n|\r|\n)/g, '<br />');
    }
    msg += '>' + elementName + elementValue + '\n\n';
  }
  msg += 'https://jira-eng-gpk2.cisco.com/jira/browse/' + jiraEvent.issue.key;
  bot.say({markdown: msg});
  // Store the key of the last notification in case the user wants to reply
  let lastNotifiedIssue = {
    storyUrl: jiraEvent.issue.self, 
    storyKey:jiraEvent.issue.key
  };
  bot.store('lastNotifiedIssue', lastNotifiedIssue);
  if (cb) {cb(null, bot);}  
}

// Dump the Jira Event to a file to see what the contents are
var fs = require('fs');
function logJiraEvent(jiraEvent) {  // eslint-disable-line no-unused-vars
  fs.writeFile("./JiraEvents/" + jiraEvent.timestamp + '-' + jiraEvent.webhookEvent + '-' +
    jiraEvent.issue_event_type_name + ".json", JSON.stringify(jiraEvent, null, 4), (err) => {
    if (err) {
      logger.error('Error writing jira event to disk:' + err);
    }
  });
}

function createTestCase(e, jiraEvent, changedField='') {
  fs.writeFile("./jira-event-test-cases/" + jiraEvent.timestamp + '-' + jiraEvent.webhookEvent + '-' +
    jiraEvent.issue_event_type_name  + '-' + changedField + ".error", JSON.stringify(jiraEvent, null, 4), (err) => {
    if (err) {
      logger.error('Error writing jira event to disk:' + err);
    }
    if (e) {
      fs.appendFile("./jira-event-test-cases/" + jiraEvent.timestamp + '-' + jiraEvent.webhookEvent + '-' +
        jiraEvent.issue_event_type_name + "_"+ e.message+".error", JSON.stringify(e, null, 4), (err) => {
        if (err) {
          logger.error('Error writing jira event to disk:' + err);
        }
      });
    }
  });
}
