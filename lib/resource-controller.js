/*
 * Copyright (c) 2018 One Hill Technologies, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const pluralize = require ('pluralize');
const assert = require ('assert');

const { extend, forOwn, isEmpty } = require ('lodash');

const {
  Action,
  ResourceController,
  HttpError,
  NotFoundError,
  computed
} = require ('@onehilltech/blueprint');

const RESOURCE_ID_PARAMS_SCHEMA = {
  in: 'params',
  errorMessage: 'The id is not valid.',
  isInt: true,
  toInt: true
};

/**
 * @class DatabaseAction
 *
 * The base class for all database actions. It includes several helper methods
 * that are needed across all database actions.
 */
const DatabaseAction = Action.extend ({
  /**
   * Translate an error code from MongoDB to an HttpError.
   *
   * @param err       Original error object
   * @returns {Promise<never>}
   */
  translateErrorToHttpError (err) {
    if (err.code === 11000) {
      // We are creating a duplicate object. Translate the error to an
      // HttpError object.
      return Promise.reject (new HttpError (400, 'already_exists', 'The resource you are creating already exists.'))
    }
    else {
      return Promise.reject (err);
    }
  },

  /**
   * Emit a event to the application.
   */
  emit () {
    return this.controller.app.emit (...arguments);
  }
});

/**
 * @class ResourceController
 *
 * Resource controller designed to operate on a Mongoose model.
 */
module.exports = ResourceController.extend ({
  /// Custom actions available only to the MongoDB resource controller.
  _actions: {
    search: {verb: 'post', path: '/search', method: 'search'},
  },

  /// Compute the plural name for the resource.
  plural: computed ({
    get () { return this.Model.options.name.plural; }
  }),

  primaryKey: computed ({
    get () { return this.Model.primaryKeyField; }
  }),

  /**
   * @class SingleResourceAction
   *
   * Base class for an action that applies to a single resource. The resource id
   * is expected to be located at req.params[id].
   */
  SingleResourceAction: computed ({
    get () {
      return Action.extend ({
        schema: {
          [this.id]: {
            in: 'params',
            isInt: true,
            toInt: true
          }
        },
      })
    }
  }),

  /**
   * Initialize the resource controller.
   */
  init (opts = {}) {
    const { name } = this.Model;

    if (!opts.name)
      opts.name = name;

    // Pass control to the base class.
    this._super.call (this, opts);

    // Prepare the options for the base class.
    assert (!!this.Model, "You must define the { Model } property.");

    const { options: { resource, softDelete = false } } = this.Model;

    assert (resource, `${name} is not a resource; model must be created using resource() method.`);

    this._softDelete = softDelete;

    // Build the validation schema for create and update.
    this._defaultValidationOptions = {scope: this.name};
  },

  /**
   * Create a new resource.
   */
  create () {
    const eventName = this._computeEventName ('created');
    const { validators, sanitizers } = this.app.resources;

    return DatabaseAction.extend ({
      // schema: validation (this.Model.schema, extend ({}, this._defaultValidationOptions, {validators, sanitizers})),

      /// Name of event for completion of action.
      eventName,

      execute (req, res) {
        const name = this.controller.name;
        const document = req.body[name];

        // First, we are going to allow the user to make any preparations needed to
        // the document. This can include adding, removing, and editing fields in the
        // original document.

        return Promise.resolve (this.prepareDocument (req, document))
          .then (document => {
            // The document is prepare for insertion. Allow the subclass to perform
            // any task before we insert the document into the database. After we
            // insert the document, allow the client to make any modifications to the
            // the inserted document.
            return Promise.resolve (this.preCreateModel (req))
              .then (() => this.createModel (req, document))
              .catch (this.translateErrorToHttpError.bind (this))
              .then (result => {
                // Emit that the resource has been created. We do it after the post create
                // method just in case the subclass makes some edits to the model that was
                // just created.
                this.emit (eventName, result);

                // Set the headers for the response. We want to make sure that we support
                // the caching headers even if they are not being used.

                //res.set (LAST_MODIFIED, result.last_modified.toUTCString ());

                return this.postCreateModel (req, result);
              });
          })
          // Initialize the result with the data. We are now going to give the
          // subclass a chance to add more content to the response.
          .then (data => this.prepareResponse (req, res, { [name]: data }))
          .then (result => res.status (200).json (result));
      },

      prepareDocument (req, doc) {
        return doc;
      },

      preCreateModel () {
        return null;
      },

      createModel (req, doc) {
        const Model = this.controller.getModelForDocument (doc);
        return Model.create (doc, { fields } );
      },

      postCreateModel (req, result) {
        return result;
      },

      prepareResponse (req, res, result) {
        return result;
      }
    });
  },

  /**
   * Get all the resources. The query parameter fields are used to filter the
   * resources by exact match. The `options` query parameter is used to control
   * the behavior/presentation of the query response.
   *
   * this._super.call (this, ...arguments).extend ({
   *
   * });
   */
  getAll () {
    const {validators,sanitizers} = this.app.resources;

    return DatabaseAction.extend ({
      //schema: validation (this.Model.schema, extend ({}, this._defaultValidationOptions, {allOptional:true, validators, sanitizers, scope: false})),

      execute (req, res) {
        let query = Object.assign ({}, req.query || {});
        let options = query._ || {};

        if (query._)
          delete query._;

        // Prepare the filter, projection, and options for the request
        // against the database.

        const preparations = [
          this.getFilter (req, query),
          this.getInclude (req),
          this.getProjection (req),
          this.getOptions (req, options)
        ];

        return Promise.all (preparations)
          .then (([filter, include, projection, options]) => {
            return Promise.resolve (this.preGetModels (req))
              .then (() => this.getModels (req, filter, include, projection, options))
              .then (models => {
                // There was nothing found. This is not the same as having an empty
                // model set returned from the query.
                if (!models)
                  return Promise.reject (new HttpError (404, 'not_found', 'Not found'));

                // We have any empty set.
                if (models.length === 0)
                  return this.postGetModels (req, models);

                // Get the most recent last modified date. This value needs to be returned
                // in the response since it represents when this collection of models was
                // last changed.

                /*
                const lastModifiedTime = models.reduce ((acc, next) => {
                  let time = next.last_modified.getTime ();
                  return time > acc ? time : acc;
                }, models[0].last_modified.getTime ());

                res.set ({
                  [LAST_MODIFIED]: new Date (lastModifiedTime).toUTCString ()
                });
                */

                return this.postGetModels (req, models);
              })
              .then (data => {
                if (options.populate) {
                  return populateHelper.populateModels (data);
                }
                else {
                  return {[this.controller.plural]: data};
                }
              })
              .then (result => {
                // We cannot have an empty result. Let's make sure that we have an
                // empty list for this collection of models.

                if (isEmpty (result))
                  result[this.controller.plural] = [];

                return this.prepareResponse (req, res, result)
              })
              .then (result => res.status (200).json (result));
          });
      },

      getFilter (req, filter) {
        return filter;
      },

      getInclude (req) {
        return null;
      },

      getProjection () {
        return {};
      },

      getOptions (req, options) {
        return options;
      },

      preGetModels (req) {
        return null;
      },

      getModels (req, filter, include, projection, options) {
        const directives = req.query._ || {};
        const { deleted } = directives;

        let attributes = Object.keys (projection);

        if (attributes.length === 0)
          attributes = undefined;

        if (!deleted && this.controller._softDelete)
          filter['_stat.deleted_at'] = {$exists: false};

        return this.controller.Model.findAll ({ include, attributes, where: filter });
      },

      postGetModels (req, models) {
        return models;
      },

      prepareResponse (req, res, result) {
        return result;
      }
    });
  },

  /**
   * Get a single resource by id from the collection. The id of the target resource
   * is expected in the request parameters under `[:resourceId]`.
   *
   * If you want to query a single resource by fields, then you need to use `getAll`.
   *
   * @returns {*}
   */
  getOne () {
    return DatabaseAction.extend ({
      schema: {
        [this.resourceId]: RESOURCE_ID_PARAMS_SCHEMA
      },

      execute (req, res) {
        // Update the options with those from the query string.
        const id = req.params[this.controller.resourceId];
        const query = req.query || {};
        const options = query._ || {};

        if (query._)
          delete query._;

        const preparations = [
          this.getId (req, id),
          this.getProjection (req),
          this.getInclude (req),
          this.getOptions (req, options)
        ];

        return Promise.all (preparations)
          .then (([id, projection, include, options]) => {
            return Promise.resolve (this.preGetModel (req))
              .then (() => this.getModel (req, id, projection, include, options))
              .then (models => {
                // There was nothing found. This is not the same as having an empty
                // model set returned from the query.

                if (models.length === 0)
                  return Promise.reject (new HttpError (404, 'not_found', 'Not found'));

                // Get the last modified date. This value needs to be returned in the
                // response since it represents when this collection of models was last changed.

                /*
                res.set ({
                  [LAST_MODIFIED]: model.last_modified.toUTCString ()
                });
                */

                return this.postGetModel (req, models[0]);
              })
              .then (data => {
                if (options.populate) {
                  return populateHelper.populateModel (data);
                }
                else {
                  return {[this.controller.name]: data};
                }
              })
              .then (result => this.prepareResponse (req, res, result))
              .then (result => res.status (200).json (result));
          });
      },

      getId (req, id) {
        return id;
      },

      getInclude (req) {
        return null;
      },

      getProjection () {
        return {};
      },

      getOptions (req, options) {
        return options;
      },

      preGetModel () {
        return null;
      },

      getModel (req, id, projection, include, options) {
        const { primaryKeyField } = this.controller.Model;

        return this.controller.Model.findAll ({
          include,
          where: {
            [primaryKeyField]: id,
          }
        });
      },

      postGetModel (req, models) {
        return models;
      },

      prepareResponse (req, res, result) {
        return result;
      }
    });
  },

  /**
   * Update a single resource in the collection. The id of the target resource to update
   * is expected in the request parameters under `[:resourceId]`.
   *
   * @returns {*}
   */
  update () {
    const defaultOptions = { upsert: false, new: true };
    const eventName = this._computeEventName ('updated');
    const {validators,sanitizers} = this.app.resources;

    return DatabaseAction.extend ({
      /*schema: extend (
        validation (this.Model.schema, extend ({}, this._defaultValidationOptions, {allOptional:true, validators, sanitizers})),
        {[this.resourceId]: RESOURCE_ID_PARAMS_SCHEMA}),*/

      eventName,

      /**
       * Execute the action.
       *
       * This is the main entry point for the action.
       *
       * @param req
       * @param res
       * @returns {Promise<*[]>}
       */
      execute (req, res) {
        const id = req.params[this.controller.resourceId];
        const update = Object.assign (req.body[this.controller.name]);

        // Allow the subclass to override the contents in both the update and
        // options variable.
        const preparations = [
          this.getId (req, id),
          this.getUpdate (req, update),
          this.getOptions (req, defaultOptions)
        ];

        return Promise.all (preparations).then (([id, update, options]) => {
          return Promise.resolve (this.preUpdateModel (req))
            .then (() => this.updateModel (req, id, update, options))
            .then (model => {
              if (!model)
                return Promise.reject (new HttpError (404, 'not_found', 'Not found'));

              this.emit (this.eventName, model);

              return this.postUpdateModel (req, model);
            })
            .then (model => this.prepareResponse (req, res, {[this.controller.name]: model}))
            .then (result => res.status (200).json (result));
        });
      },

      getId (req, id) {
        return id;
      },

      /**
       * Get the update values for the resource.
       *
       * @param req
       * @param update
       * @returns {update|Promise}
       */
      getUpdate (req, update) {
        return update;
      },

      /**
       * Get the update options for the request.
       *
       * @param req
       * @param options
       * @returns {options|Promise}
       */
      getOptions (req, options) {
        return options;
      },

      /**
       * Perform an operation before the update.
       *
       * @returns {null|Promise}
       */
      preUpdateModel (req) {
        return null;
      },

      updateModel (req, id, update, options) {
        const { Model } = this.controller;
        const where = {[this.controller.primaryKey]: id};

        return Model.findOne ({where}).then (model => !!model ? model.update (update) : Promise.reject (new NotFoundError ('not_found', 'The resource does not exist.')));
      },

      /**
       * Perform an operation after the update. This method must return the result
       * model, or a Promise the resolve to the result model.
       *
       * @param req
       * @param model
       * @returns {model|Promise}
       */
      postUpdateModel (req, model) {
        return model;
      },

      /**
       * Update the response before it is sent to the client.
       *
       * @param res
       * @param data
       * @returns {data|Promise}
       */
      prepareResponse (req, res, data) {
        return data;
      }
    });
  },

  /**
   * Delete a single resource from the collection. The id of the target resource
   * to delete is expected in the request parameters under `[:resourceId]`.
   */
  delete () {
    const eventName = this._computeEventName ('deleted');

    return DatabaseAction.extend ({
      schema: {
        [this.resourceId]: RESOURCE_ID_PARAMS_SCHEMA
      },

      eventName,

      execute (req, res) {
        const id = req.params[this.controller.id];

        return Promise.resolve (this.getId (req, id)).then (id => {
          return Promise.resolve (this.preDeleteModel (req))
            .then (() => this.deleteModel (req, id))
            .then (deleteCount => {
              // If there is no model, then we need to let the client know.
              if (deleteCount === 0)
                return Promise.reject (new HttpError (404, 'not_found', 'Not found'));

              // Notify all that are listening that we just deleted an resource
              // from the collection.
              this.emit (this.eventName, deleteCount);

              return this.postDeleteModel (req, deleteCount);
            })
            .then (model => this.prepareResponse (req, res, model, true))
            .then (result => res.status (200).json (result));
        });
      },

      getId (req, id) {
        return id;
      },

      preDeleteModel (req) {

      },

      deleteModel (req, id) {
        const { primaryKeyField } = this.controller.Model;

        return this.controller.Model.destroy ({
          where: {
            [primaryKeyField]: id
          }
        });
      },

      postDeleteModel (req, result) {
        return result;
      },

      prepareResponse (req, res, model, result) {
        return result;
      }
    });
  },

  /**
   * Return the number of resources.
   */
  count () {
    const eventName = this._computeEventName ('counted');

    return DatabaseAction.extend ({
      execute (req, res) {
        // Make a copy of the original query since we are going to make changes to it
        // before passing it to the subclass.
        const filter = Object.assign ({}, req.query);

        if (filter._)
          delete filter._;

        return Promise.resolve (this.getFilter (req, filter))
          .then (filter => {
            return Promise.resolve (this.preCountModels (req))
              .then (() => this.getCount (req, filter))
              .then (count => {
                this.emit (eventName, count);
                return this.postCountModels (req, count)
              })
              .then (count => this.prepareResponse (req, res, {count: count}))
              .then (response => res.status (200).json (response));
          });
      },

      getFilter (req, filter) {
        return filter;
      },

      getCount (req, filter) {
        // Get the directives from the request, and delete them from the filter
        // if they exist.
        const options = req.query._ || {};
        const { deleted = false } = options;

        if (!deleted && this.controller._softDelete)
          filter['_stat.deleted_at'] = {$exists: false};

        return this.controller.Model.countDocuments (filter);
      },

      preCountModels () {

      },

      postCountModels (req, count) {
        return count;
      },

      prepareResponse (req, res, response) {
        return response;
      }
    });
  },

  /**
   * Search for resources that match the search criteria.
   */
  search () {
    return DatabaseAction.extend ({
      schema: {
        'search.query': {
          in: 'body'
        },

        'search.options': {
          in: 'body',
          optional: true,
        },

        'search._': {
          in: 'body',
          optional: true
        }
      },

      execute (req, res) {
        // Make aa copy of the original search. This way, we can change the search
        // object without changing it within the request.
        const { search } = req.body;

        let query = Object.assign ({}, search.query);
        let options = Object.assign ({}, search.options);

        const directives = search._ || {};

        // Prepare the filter, projection, and options for the request
        // against the database.

        const preparations = [
          this.getQuery (req, query),
          this.getProjection (req),
          this.getOptions (req, options)
        ];

        return Promise.all (preparations)
          .then (([query, projection, options]) => {
            return Promise.resolve (this.preGetModels (req))
              .then (() => this.getModels (req, query, projection, options, directives))
              .then (models => {
                // There was nothing found. This is not the same as having an empty
                // model set returned from the query.
                if (!models)
                  return Promise.reject (new HttpError (404, 'not_found', 'Not found'));

                // We have any empty set.
                if (models.length === 0)
                  return this.postGetModels (req, models);

                // Get the most recent last modified date. This value needs to be returned
                // in the response since it represents when this collection of models was
                // last changed.

                const lastModifiedTime = models.reduce ((acc, next) => {
                  let time = next.last_modified.getTime ();
                  return time > acc ? time : acc;
                }, models[0].last_modified.getTime ());

                res.set ({
                  [LAST_MODIFIED]: new Date (lastModifiedTime).toUTCString ()
                });

                return this.postGetModels (req, models);
              })
              .then (data => {
                if (directives.populate) {
                  return populateHelper.populateModels (data);
                }
                else {
                  return {[this.controller.plural]: data};
                }
              })
              .then (result => {
                // We cannot have an empty result. Let's make sure that we have an
                // empty list for this collection of models.

                if (isEmpty (result))
                  result[this.controller.plural] = [];

                return this.prepareResponse (req, res, result)
              })
              .then (result => res.status (200).json (result));
          });
      },

      getQuery (req, query) {
        return query;
      },

      getProjection () {
        return {};
      },

      getOptions (req, options) {
        return options;
      },

      preGetModels (/* req */) {
        return null;
      },

      getModels (req, query, projection, options = {}, directives = {}) {
        const { deleted } = directives;

        if (!deleted && this.controller._softDelete)
          query['_stat.deleted_at'] = {$exists: false};

        return this.controller.Model.find (query, projection, options);
      },

      postGetModels (req, models) {
        return models;
      },

      prepareResponse (req, res, result) {
        return result;
      }
    });
  },

  /**
   * Get the Mongoose model definition for the target. This is important if the
   * document if for an inherited model.
   *
   * @param doc         The document
   * @returns {Model}
   * @private
   */
  getModelForDocument (doc) {
    return this.Model;
  },

  /**
   * Compute the event name for the resource.
   *
   * @param action
   * @returns {string}
   * @private
   */
  _computeEventName (action) {
    let prefix = this.namespace || '';

    if (prefix.length !== 0)
      prefix += '.';

    return `${prefix}${this.name}.${action}`;
  }
});
