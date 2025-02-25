'use strict';

const fs = require('fs-extra');
const path = require('path');
const test = require('ava');
const { toCamel } = require('snake-camel');
const cryptoRandomString = require('crypto-random-string');
const uuidv4 = require('uuid/v4');
const proxyquire = require('proxyquire');

const StepFunctions = require('@cumulus/aws-client/StepFunctions');
const {
  sns,
  sqs,
} = require('@cumulus/aws-client/services');
const {
  localStackConnectionEnv,
  destroyLocalTestDb,
  generateLocalTestDb,
  CollectionPgModel,
  ProviderPgModel,
  PdrPgModel,
  ExecutionPgModel,
  GranulePgModel,
  migrationDir,
} = require('@cumulus/db');
const {
  UnmetRequirementsError,
} = require('@cumulus/errors');
const {
  Search,
} = require('@cumulus/es-client/search');
const {
  createTestIndex,
  cleanupTestIndex,
} = require('@cumulus/es-client/testUtils');
const {
  constructCollectionId,
} = require('@cumulus/message/Collections');
const {
  getMessageExecutionParentArn,
} = require('@cumulus/message/Executions');
const {
  writeRecords,
} = require('../../../lambdas/sf-event-sqs-to-db-records');

const {
  handler,
} = proxyquire('../../../lambdas/sf-event-sqs-to-db-records', {
  '@cumulus/aws-client/SQS': {
    sendSQSMessage: (queue, message) => Promise.resolve([queue, message]),
  },
  '@cumulus/message/Executions': {
    getMessageExecutionParentArn: (cumulusMessage) => {
      if (cumulusMessage.fail === true) {
        throw new Error('Intentional failure: test case');
      }
      return getMessageExecutionParentArn(cumulusMessage);
    },
  },
});

const { fakeFileFactory, fakeGranuleFactoryV2 } = require('../../../lib/testUtils');

const loadFixture = (filename) =>
  fs.readJson(
    path.join(
      __dirname,
      '..',
      'fixtures',
      'sf-event-sqs-to-db-records',
      filename
    )
  );

let fixture;

const runHandler = async ({
  cumulusMessage = {},
  stateMachineArn,
  executionArn,
  executionName,
  testDbName,
  ...additionalParams
}) => {
  fixture.resources = [executionArn];
  fixture.detail.executionArn = executionArn;
  fixture.detail.stateMachineArn = stateMachineArn;
  fixture.detail.name = executionName;

  fixture.detail.input = JSON.stringify(cumulusMessage);

  const sqsEvent = {
    ...additionalParams,
    Records: [{
      eventSource: 'aws:sqs',
      body: JSON.stringify(fixture),
    }],
    env: {
      ...localStackConnectionEnv,
      PG_DATABASE: testDbName,
    },
  };
  const handlerResponse = await handler(sqsEvent);
  return { executionArn, handlerResponse, sqsEvent };
};

const generateRDSCollectionRecord = (params) => ({
  name: `${cryptoRandomString({ length: 10 })}collection`,
  version: '0.0.0',
  duplicate_handling: 'replace',
  granule_id_validation_regex: '^MOD09GQ\\.A[\\d]{7}\.[\\S]{6}\\.006\\.[\\d]{13}$',
  granule_id_extraction_regex: '(MOD09GQ\\.(.*))\\.hdf',
  sample_file_name: 'MOD09GQ.A2017025.h21v00.006.2017034065104.hdf',
  files: JSON.stringify([{ regex: '^.*\\.txt$', sampleFileName: 'file.txt', bucket: 'bucket' }]),
  created_at: new Date(),
  updated_at: new Date(),
  ...params,
});

test.before(async (t) => {
  t.context.testDbName = `sfEventSqsToDbRecords_${cryptoRandomString({ length: 10 })}`;
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: t.context.testDbName,
  };

  t.context.testOverrides = {
    stepFunctionUtils: {
      ...StepFunctions,
      describeExecution: () => Promise.resolve({}),
    },
  };

  const { knex, knexAdmin } = await generateLocalTestDb(t.context.testDbName, migrationDir);
  t.context.testKnex = knex;
  t.context.testKnexAdmin = knexAdmin;

  const { esIndex, esClient } = await createTestIndex();
  t.context.esIndex = esIndex;
  t.context.esClient = esClient;

  t.context.esExecutionsClient = new Search(
    {},
    'execution',
    t.context.esIndex
  );
  t.context.esPdrsClient = new Search(
    {},
    'pdr',
    t.context.esIndex
  );
  t.context.esGranulesClient = new Search(
    {},
    'granule',
    t.context.esIndex
  );

  t.context.collectionPgModel = new CollectionPgModel();
  t.context.executionPgModel = new ExecutionPgModel();
  t.context.granulePgModel = new GranulePgModel();
  t.context.pdrPgModel = new PdrPgModel();
  t.context.providerPgModel = new ProviderPgModel();

  fixture = await loadFixture('execution-running-event.json');

  const executionsTopicName = cryptoRandomString({ length: 10 });
  const pdrsTopicName = cryptoRandomString({ length: 10 });
  const executionsTopic = await sns().createTopic({ Name: executionsTopicName }).promise();
  const pdrsTopic = await sns().createTopic({ Name: pdrsTopicName }).promise();
  process.env.execution_sns_topic_arn = executionsTopic.TopicArn;
  process.env.pdr_sns_topic_arn = pdrsTopic.TopicArn;
  t.context.ExecutionsTopicArn = executionsTopic.TopicArn;
  t.context.PdrsTopicArn = pdrsTopic.TopicArn;
});

test.beforeEach(async (t) => {
  process.env.RDS_DEPLOYMENT_CUMULUS_VERSION = '3.0.0';
  t.context.postRDSDeploymentVersion = '4.0.0';
  t.context.preRDSDeploymentVersion = '2.9.99';

  t.context.collection = generateRDSCollectionRecord();
  t.context.collectionId = constructCollectionId(
    t.context.collection.name,
    t.context.collection.version
  );

  const topicName = cryptoRandomString({ length: 10 });
  const { TopicArn } = await sns().createTopic({ Name: topicName }).promise();
  process.env.granule_sns_topic_arn = TopicArn;
  t.context.TopicArn = TopicArn;

  const QueueName = cryptoRandomString({ length: 10 });
  const { QueueUrl } = await sqs().createQueue({ QueueName }).promise();
  t.context.QueueUrl = QueueUrl;
  const getQueueAttributesResponse = await sqs().getQueueAttributes({
    QueueUrl,
    AttributeNames: ['QueueArn'],
  }).promise();
  const QueueArn = getQueueAttributesResponse.Attributes.QueueArn;

  const { SubscriptionArn } = await sns().subscribe({
    TopicArn,
    Protocol: 'sqs',
    Endpoint: QueueArn,
  }).promise();

  await sns().confirmSubscription({
    TopicArn,
    Token: SubscriptionArn,
  }).promise();

  const stateMachineName = cryptoRandomString({ length: 5 });
  t.context.stateMachineArn = `arn:aws:states:${fixture.region}:${fixture.account}:stateMachine:${stateMachineName}`;

  t.context.executionName = cryptoRandomString({ length: 5 });
  t.context.executionArn = `arn:aws:states:${fixture.region}:${fixture.account}:execution:${stateMachineName}:${t.context.executionName}`;

  t.context.provider = {
    id: `provider${cryptoRandomString({ length: 5 })}`,
    host: 'test-bucket',
    protocol: 's3',
  };

  t.context.pdrName = cryptoRandomString({ length: 10 });
  t.context.pdr = {
    name: t.context.pdrName,
    PANSent: false,
    PANmessage: 'test',
  };

  t.context.granuleId = cryptoRandomString({ length: 10 });
  t.context.files = [fakeFileFactory()];
  t.context.granule = fakeGranuleFactoryV2({
    files: t.context.files,
    granuleId: t.context.granuleId,
  });

  t.context.cumulusMessage = {
    cumulus_meta: {
      workflow_start_time: Date.now(),
      cumulus_version: t.context.postRDSDeploymentVersion,
      state_machine: t.context.stateMachineArn,
      execution_name: t.context.executionName,
    },
    meta: {
      status: 'running',
      collection: toCamel(t.context.collection),
      provider: t.context.provider,
    },
    payload: {
      key: 'my-payload',
      pdr: t.context.pdr,
      granules: [t.context.granule],
    },
  };

  const [pgCollectionRecord] = await t.context.collectionPgModel
    .create(t.context.testKnex, t.context.collection);
  t.context.collectionCumulusId = pgCollectionRecord.cumulus_id;

  [t.context.providerCumulusId] = await t.context.providerPgModel
    .create(t.context.testKnex, {
      name: t.context.provider.id,
      host: t.context.provider.host,
      protocol: t.context.provider.protocol,
    });
});

test.after.always(async (t) => {
  const {
    PdrsTopicArn,
    ExecutionsTopicArn,
  } = t.context;
  await destroyLocalTestDb({
    knex: t.context.testKnex,
    knexAdmin: t.context.testKnexAdmin,
    testDbName: t.context.testDbName,
  });
  await cleanupTestIndex(t.context);
  await sns().deleteTopic({ TopicArn: ExecutionsTopicArn }).promise();
  await sns().deleteTopic({ TopicArn: PdrsTopicArn }).promise();
});

test('writeRecords() throws error if requirements to write execution to PostgreSQL are not met', async (t) => {
  const {
    cumulusMessage,
    testKnex,
  } = t.context;

  // add reference in message to object that doesn't exist
  cumulusMessage.cumulus_meta.asyncOperationId = uuidv4();

  await t.throwsAsync(
    writeRecords({
      cumulusMessage,
      knex: testKnex,
    }),
    { instanceOf: UnmetRequirementsError }
  );
});

test('writeRecords() does not write granules/PDR if writeExecution() throws general error', async (t) => {
  const {
    collectionCumulusId,
    cumulusMessage,
    testKnex,
    executionArn,
    pdrName,
    granuleId,
    testOverrides,
  } = t.context;

  delete cumulusMessage.meta.status;

  await t.throwsAsync(writeRecords({
    cumulusMessage,
    knex: testKnex,
    testOverrides,
  }));

  t.false(
    await t.context.executionPgModel.exists(t.context.testKnex, { arn: executionArn })
  );
  t.false(
    await t.context.pdrPgModel.exists(t.context.testKnex, { name: pdrName })
  );
  t.false(
    await t.context.granulePgModel.exists(
      t.context.testKnex,
      { granule_id: granuleId, collection_cumulus_id: collectionCumulusId }
    )
  );
});

test.serial('writeRecords() writes records to Dynamo and PostgreSQL', async (t) => {
  const {
    collectionCumulusId,
    cumulusMessage,
    testKnex,
    executionArn,
    pdrName,
    granuleId,
    testOverrides,
  } = t.context;

  await writeRecords({ cumulusMessage, knex: testKnex, testOverrides });

  t.true(
    await t.context.executionPgModel.exists(t.context.testKnex, { arn: executionArn })
  );
  t.true(
    await t.context.pdrPgModel.exists(t.context.testKnex, { name: pdrName })
  );
  t.true(
    await t.context.granulePgModel.exists(
      t.context.testKnex,
      { granule_id: granuleId, collection_cumulus_id: collectionCumulusId }
    )
  );
});

test('Lambda sends message to DLQ when writeRecords() throws an error', async (t) => {
  const {
    handlerResponse,
    sqsEvent,
  } = await runHandler({
    ...t.context,
    cumulusMessage: { fail: true },
  });

  t.is(handlerResponse[0][1].body, sqsEvent.Records[0].body);
});

test.serial('writeRecords() discards an out of order message that is older than an existing message without error or write', async (t) => {
  const {
    collectionCumulusId,
    cumulusMessage,
    testKnex,
    pdrName,
    granuleId,
    testOverrides,
  } = t.context;

  const pdrPgModel = new PdrPgModel();
  const granulePgModel = new GranulePgModel();

  const timestamp = Date.now();
  const olderTimestamp = timestamp - 10000;

  cumulusMessage.payload.granules[0].createdAt = timestamp;
  cumulusMessage.cumulus_meta.workflow_start_time = timestamp;
  await writeRecords({ cumulusMessage, knex: testKnex, testOverrides });

  cumulusMessage.payload.granules[0].createdAt = olderTimestamp;
  cumulusMessage.cumulus_meta.workflow_start_time = olderTimestamp;
  await t.notThrowsAsync(writeRecords({ cumulusMessage, knex: testKnex, testOverrides }));

  t.deepEqual(
    new Date(timestamp),
    (await granulePgModel.get(
      testKnex,
      { granule_id: granuleId, collection_cumulus_id: collectionCumulusId }
    )).created_at
  );
  t.deepEqual(
    new Date(timestamp),
    (await pdrPgModel.get(testKnex, { name: pdrName })).created_at
  );
});

test.serial('writeRecords() discards an out of order message that has an older status without error or write', async (t) => {
  const {
    collectionCumulusId,
    cumulusMessage,
    testKnex,
    executionArn,
    pdrName,
    granuleId,
    testOverrides,
  } = t.context;

  const executionPgModel = new ExecutionPgModel();
  const pdrPgModel = new PdrPgModel();
  const granulePgModel = new GranulePgModel();

  cumulusMessage.meta.status = 'completed';
  await writeRecords({ cumulusMessage, knex: testKnex, testOverrides });

  cumulusMessage.meta.status = 'running';
  await t.notThrowsAsync(writeRecords({ cumulusMessage, knex: testKnex, testOverrides }));

  t.is('completed', (await executionPgModel.get(testKnex, { arn: executionArn })).status);
  t.is('completed', (await granulePgModel.get(
    testKnex,
    { granule_id: granuleId, collection_cumulus_id: collectionCumulusId }
  )).status);
  t.is('completed', (await pdrPgModel.get(testKnex, { name: pdrName })).status);
});
