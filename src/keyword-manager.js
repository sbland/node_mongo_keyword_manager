const mongoose = require('mongoose');
const { connectModels } = require('../mongodb/connectMiddleware');
const Models = require('../models');

const getUpdatedDocuments = async (keywordModels, lastCheckedDate) => {
  const updatedDocuments = await Promise.all(
    Object.entries(keywordModels).map(async ([key, Model]) => {
      const d = new Date(lastCheckedDate);
      const docs = await Model.find({ updatedAt: { $gt: d } }).exec();
      return [key, docs];
    })
  );

  return updatedDocuments
    .filter((v) => v[1].length > 0)
    .reduce((acc, v) => ({ ...acc, [v[0]]: v[1] }), {});
};

const getModelKeywordFields = (Model) => {
  const {
    schema: { obj: schema },
  } = Model;
  const keywords = Object.entries(schema)
    .filter(([, meta]) => meta.keyword)
    .map(([key, meta]) => {
      return [key, meta]; // TODO: May need meta here too
    });
  return keywords;
};

const getKeywordFields = (keywordModels) => {
  const keywordFieldsMap = Object.entries(keywordModels).map(([id, Model]) => {
    const keywords = getModelKeywordFields(Model);
    return [id, keywords];
  });

  return (
    keywordFieldsMap
      // .filter((v) => v[1].length > 0)
      .reduce((acc, v) => ({ ...acc, [v[0]]: v[1] }), {})
  );
};

/**
 * Get a mapping of which models reference each other
 *
 * Returns a dict where key is model id and
 * value is a tuple of ([reference model id],[field], [fieldIndex])
 * Reference model id is the id of the model that references the current model
 * Field is the field that references the current model
 * fieldIndex is the index of this field in the reference model.
 *   We need to know the fieldIndex to know the index of the keywords to change
 */
const getReferenceMatrix = (models) => {
  return Object.entries(models)
    .map(([id, Model]) => {
      return [
        id,
        Object.entries(models)
          .map(([idb, ModelB]) => {
            const {
              schema: { obj: schema },
            } = ModelB;
            return [
              idb,
              Object.entries(schema)
                .filter(([, meta]) => meta.keyword)
                .map(([fieldId, meta], i) => [fieldId, meta, i])
                .filter(
                  ([, meta]) =>
                    meta.type === mongoose.Schema.ObjectId && meta.ref === Model.modelName
                )
                .map(([fieldId, , i]) => [fieldId, i]),
            ];
          })
          .filter(([, fields]) => fields.length > 0),
      ];
    })
    .reduce((acc, v) => ({ ...acc, [v[0]]: v[1] }), {});
};

const updateLocalKeywords = async (
  ModelId,
  doc,
  keywordMaps,
  modelReferenceMap,
  connectedModels
) => {
  const { [ModelId]: modelKeywordMap } = keywordMaps;
  const localKeywordMap = modelKeywordMap.filter(
    ([, meta]) => meta.type !== mongoose.Schema.ObjectId
  );
  const refKeywordMap = modelKeywordMap.filter(
    ([, meta]) => meta.type === mongoose.Schema.ObjectId
  );
  const localKeywords = localKeywordMap.map(([k]) => doc[k]);

  const refKeywords = await Promise.all(
    refKeywordMap.map(async ([k, meta]) => {
      if (doc[k]) {
        const refModelName = meta.ref;
        // TODO: Improve getting ref model
        const refModel = Object.values(connectedModels).find(
          (model) => model.modelName === refModelName
        );
        const refObj = await refModel.findOne({ _id: doc[k] });
        return refObj.label || refObj.name;
      }
      return null;
    })
  );
  // eslint-disable-next-line no-param-reassign
  doc.keywords = localKeywords.concat(refKeywords);
  await doc.save({ timestamps: false });
};

/* Update the keywords on all documents that reference the current document
 *
 */
const updateRefKeywords = async (ModelId, doc, keywordMaps, modelReferenceMap, connectedModels) => {
  // TODO: for each document find all documents this document references and update the keywords on this document
  const { [ModelId]: referencedModels } = modelReferenceMap;

  await Promise.all(
    // For each model that references this model we have the model id and a list of fields that reference this model
    referencedModels.map(async ([refModelId, fields]) => {
      //  Each field is a tuple of the field id and the field index
      const { [refModelId]: RefModel } = connectedModels;
      // TODO: Could be any of the fields. Should we check all fields?
      // Find all docs that reference this doc using the first fields id
      const connectedDocs = await RefModel.find({ [fields[0][0]]: doc._id });
      // TODO: For each connected doc we need to update the keywords
      await Promise.all(
        connectedDocs.map(async (refDoc) => {
          // eslint-disable-next-line no-param-reassign
          refDoc.keywords[fields[0][1]] = doc.label || doc.name;
          refDoc.markModified('keywords');
          await refDoc.save({ timestamps: false });
        })
      );
      // NOTE: How do we do this when we don't know which field has been modified?
    })
  );
};

const updateDocKeywords = async (ModelId, doc, keywordMaps, modelReferenceMap, connectedModels) => {
  // for each document find all documents that reference this document and update the keywords
  await updateLocalKeywords(ModelId, doc, keywordMaps, modelReferenceMap, connectedModels);
  await updateRefKeywords(ModelId, doc, keywordMaps, modelReferenceMap, connectedModels);
};

const updateKeywords = async (keywordModels, keywordMaps, modelReferenceMap, lastUpdate) => {
  const updatedDocuments = await getUpdatedDocuments(keywordModels, lastUpdate);
  // NOTE: We run in series here to avoid clashing updates.
  const fns = Object.entries(updatedDocuments).map(([ModelId, docs]) => async () => {
    console.info(ModelId);
    console.info(docs);
    await Promise.all(
      docs.map(async (doc) => {
        await updateDocKeywords(ModelId, doc, keywordMaps, modelReferenceMap, keywordModels);
      })
    );
  });
  await fns.reduce((p, fn) => p.then(fn), Promise.resolve());
};

const updateKeywordsWrapper = async (keywordModels, lastUpdate) => {
  const keywordFieldMap = getKeywordFields(keywordModels);
  const modelReferenceMap = getReferenceMatrix(keywordModels);
  return updateKeywords(keywordModels, keywordFieldMap, modelReferenceMap, lastUpdate);
};

const initializeTextSearchUpdater = async (interval, dbConnection) => {
  const modelsConnected = connectModels(Models)(dbConnection.connection);
  const modelReferenceMap = getReferenceMatrix(modelsConnected);
  const keywordFieldMap = getKeywordFields(modelsConnected);
  let lastUpdateTime = Date.now();
  let updatingKeywords = false;

  const runningInterval = setInterval(async () => {
    console.info('Updating keywords');
    if (!updatingKeywords) {
      updatingKeywords = true;
      const nextUpdate = Date.now();
      await updateKeywords(
        modelsConnected,
        keywordFieldMap,
        modelReferenceMap,
        lastUpdateTime
      ).then(() => {
        updatingKeywords = false;
      });
      lastUpdateTime = nextUpdate;
    }
  }, interval);
  return runningInterval;
};

module.exports = {
  initializeTextSearchUpdater,
  updateKeywords,
  getUpdatedDocuments,
  getModelKeywordFields,
  getKeywordFields,
  getReferenceMatrix,
  updateKeywordsWrapper,
};
