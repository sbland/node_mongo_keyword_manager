const resetData = require('../resetData');
const Models = require('../models');
const { cleanup } = require('../RestApi/resetTestData');
const DbConnection = require('../mongodb/DbConnection');
const { connectModels } = require('../mongodb/connectMiddleware');
const { stripOutVariableFields } = require('../RestApi/resetTestData');
const {
  // initializeTextSearchUpdater,
  updateKeywords,
  getUpdatedDocuments,
  getModelKeywordFields,
  getKeywordFields,
  getReferenceMatrix,
} = require('./keywordManager');

const models = Object.values(Models);

const updateProject = async (modelsConnected) => {
  const { ProjectModel, CountryModel } = modelsConnected;
  const country = await CountryModel.findOne({}).exec();
  const initialProject = await ProjectModel.findOneAndUpdate({}, { $set: { country } });
  const updatedProject = await ProjectModel.findOne({ uid: initialProject.uid });
  return [updatedProject, country];
};

const updateCountry = async (modelsConnected, uid) => {
  const { CountryModel } = modelsConnected;
  await CountryModel.findOneAndUpdate({ uid }, { $set: { label: 'NewCountryName' } }).exec();
  const countryUpdated = await CountryModel.findOne({ uid }).exec();
  return countryUpdated;
};

describe.skip('Keyword Manager', () => {
  let dbConnection;
  let modelsConnected;

  beforeAll(async () => {
    dbConnection = new DbConnection(models, false, 10, 1000, 'keywordManager');
    await dbConnection.connect();
    await resetData(dbConnection);
    modelsConnected = connectModels(Models)(dbConnection.connection);
  });

  afterAll(async () => {
    await cleanup(dbConnection.connection);
    await dbConnection.disconnect();
  });

  describe('Running Interval', () => {
    //
    test.skip('should run update keywords every interval', async () => {
      //
    });
  });

  describe('Get reference matrix', () => {
    test('should get a mapping of which models reference each other', () => {
      const referenceMap = getReferenceMatrix(modelsConnected);

      expect(referenceMap.CountryModel).toEqual([
        ['ProjectModel', [['country', 4]]],
        ['ProjectContactModel', [['country', 5]]],
      ]);
      expect(referenceMap).toMatchSnapshot();
    });
  });
  describe('Finding updated documents', () => {
    test('should return empty dict if there are no updated documents', async () => {
      const updatedDocuments = await getUpdatedDocuments(modelsConnected, Date.now());
      expect(updatedDocuments).toEqual({});
    });
    test('should return all updated documents in each model', async () => {
      const lastUpdateTime = Date.now() - 10;
      const [updatedProject] = await updateProject(modelsConnected);

      const updatedDocuments = await getUpdatedDocuments(modelsConnected, lastUpdateTime);
      expect(stripOutVariableFields(updatedDocuments)).toEqual({
        ProjectModel: [stripOutVariableFields(updatedProject.toObject())],
      });
    });
    test('should only return recently updated documents', async () => {
      let lastUpdateTime = Date.now() - 10;
      const [updatedProject] = await updateProject(modelsConnected);

      const updatedDocuments = await getUpdatedDocuments(modelsConnected, lastUpdateTime);
      expect(stripOutVariableFields(updatedDocuments)).toEqual({
        ProjectModel: [stripOutVariableFields(updatedProject.toObject())],
      });
      lastUpdateTime = Date.now() - 5;

      const updatedDocumentsAgain = await getUpdatedDocuments(modelsConnected, lastUpdateTime);
      expect(stripOutVariableFields(updatedDocumentsAgain)).toEqual({});
    });
  });
  describe('Get keyword fields', () => {
    test('should get all keyword fields for model', () => {
      const keywords = getModelKeywordFields(Models.Project);
      expect(keywords.map(([k]) => k).sort()).toEqual(
        ['country', 'name', 'quoteRef', 'ref', 'yourRef', 'rep', 'estimator'].sort()
      );
    });
    test('should get all keyword fields for all models', () => {
      const keywords = getKeywordFields(modelsConnected);
      expect(keywords).toMatchSnapshot();
    });
  });
  describe('Running Update keywords', () => {
    describe('Changes after updating a single document', () => {
      beforeAll(async () => {
        // const { ProjectModel } = modelsConnected;
      });
      test('have only local keywords initially', async () => {
        const [updatedProject, country] = await updateProject(modelsConnected);
        expect(updatedProject.country).toEqual(country._id);
        expect(updatedProject.keywords.toObject()).toEqual([
          updatedProject.name,
          updatedProject.ref,
          updatedProject.quoteRef || null,
          updatedProject.yourRef || null,
          null, // country
          null, // rep
          null, // estimator
        ]);
      });
      test('have updated keywords in document', async () => {
        const lastUpdateTime = Date.now() - 1;
        const [updatedProject, country] = await updateProject(modelsConnected);
        const keywordFieldMap = getKeywordFields(modelsConnected);
        const modelReferenceMap = getReferenceMatrix(modelsConnected);
        await updateKeywords(modelsConnected, keywordFieldMap, modelReferenceMap, lastUpdateTime);
        const { ProjectModel } = modelsConnected;
        const updatedProjectPost = await ProjectModel.findOne({
          _id: updatedProject._id,
        }).exec();

        expect(updatedProjectPost.keywords.toObject()).toEqual([
          updatedProject.name,
          updatedProject.ref,
          updatedProject.quoteRef || null,
          updatedProject.yourRef || null,
          country.label,
          null, // rep
          null, // estimator
        ]);
      });

      test('should have updated keywords in linked document', async () => {
        const lastUpdateTime = Date.now() - 1;
        const [updatedProject, country] = await updateProject(modelsConnected);
        const keywordFieldMap = getKeywordFields(modelsConnected);
        const modelReferenceMap = getReferenceMatrix(modelsConnected);
        await updateKeywords(modelsConnected, keywordFieldMap, modelReferenceMap, lastUpdateTime);
        const lastUpdateTimeNew = Date.now() - 1;

        const countryUpdated = await updateCountry(modelsConnected, country.uid);

        await updateKeywords(
          modelsConnected,
          keywordFieldMap,
          modelReferenceMap,
          lastUpdateTimeNew
        );
        const { ProjectModel } = modelsConnected;
        const updatedProjectPost = await ProjectModel.findOne({
          _id: updatedProject._id,
        }).exec();

        expect(updatedProjectPost.keywords.toObject()).toEqual([
          updatedProject.name,
          updatedProject.ref,
          updatedProject.quoteRef || null,
          updatedProject.yourRef || null,
          countryUpdated.label,
          null, // rep
          null, // estimator
        ]);
      });
      test('should not have updated updatedat timestamp', async () => {
        const lastUpdateTime = Date.now() - 1;
        const [updatedProject] = await updateProject(modelsConnected);
        const keywordFieldMap = getKeywordFields(modelsConnected);
        const modelReferenceMap = getReferenceMatrix(modelsConnected);
        await updateKeywords(modelsConnected, keywordFieldMap, modelReferenceMap, lastUpdateTime);
        const { ProjectModel } = modelsConnected;
        const updatedProjectPost = await ProjectModel.findOne({
          _id: updatedProject._id,
        }).exec();

        expect(updatedProjectPost.updatedAt).toEqual(updatedProject.updatedAt);
      });
    });
  });
});
