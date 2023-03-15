import _ from 'lodash'
import { AbstractModule } from 'adapt-authoring-core'
import Ajv from 'ajv/dist/2020.js'
import glob from 'glob'
import JsonSchema from './JsonSchema.js'
import Keywords from './Keywords.js'
import safeRegex from 'safe-regex'
/**
 * Module which add support for the JSON Schema specification
 * @memberof jsonschema
 * @extends {AbstractModule}
 */
class JsonSchemaModule extends AbstractModule {
  /** @override */
  async init () {
    this.app.jsonschema = this
    /**
     * Reference to all registed schemas
     * @type {Object}
     */
    this.schemas = {}
    /**
     * Temporary store of extension schemas
     * @type {Object}
     */
    this.schemaExtensions = {}
    /**
     * Reference to the Ajv instance
     * @type {external:Ajv}
     */
    this.validator = new Ajv({
      addUsedSchema: false,
      allErrors: true,
      allowUnionTypes: true,
      loadSchema: this.getSchema.bind(this),
      removeAdditional: 'all',
      strict: false,
      verbose: true,
      keywords: Keywords.all
    })
    this.addStringFormats({
      'date-time': /[A-za-z0-9:+()]+/,
      email: /^[A-Z0-9a-z._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}$/,
      time: /^(\d{2}):(\d{2}):(\d{2})\+(\d{2}):(\d{2})$/,
      uri: /^(.+):\/\/(www\.)?[-a-zA-Z0-9@:%_+.~#?&//=]{1,256}/
    })
    this.onReady()
      .then(() => this.app.waitForModule('config', 'errors'))
      .then(() => this.addStringFormats(this.getConfig('formatOverrides')))
      .then(() => this.registerSchemas())
      .catch(e => this.log('error', e))
  }

  /**
   * Adds string formats to the Ajv validator
   */
  addStringFormats (formats) {
    Object.entries(formats).forEach(([name, re]) => {
      const isUnsafe = !safeRegex(re)
      if (isUnsafe) this.log('warn', `unsafe RegExp for format '${name}' (${re}), using default`)
      this.validator.addFormat(name, isUnsafe ? /.*/ : re)
    })
  }

  /**
   * Adds a new keyword to be used in JSON schemas
   * @param {AjvKeyword} definition
   */
  addKeyword (definition) {
    try {
      this.validator.addKeyword(definition)
    } catch (e) {
      this.log('warn', `failed to define keyword '${definition.keyword}', ${e}`)
    }
  }

  /**
   * Searches all Adapt dependencies for any local JSON schemas and registers them for use in the app. Schemas must be located in in a `/schema` folder, and be named appropriately: `*.schema.json`.
   * @return {Promise}
   */
  async registerSchemas () {
    this.schemas = {}
    return Promise.all(Object.values(this.app.dependencies).map(async d => {
      const files = await new Promise((resolve, reject) => {
        glob('schema/*.schema.json', { cwd: d.rootDir, absolute: true }, (e, f) => e ? reject(e) : resolve(f))
      });
      (await Promise.allSettled(files.map(f => this.registerSchema(f))))
        .filter(r => r.status === 'rejected')
        .forEach(r => this.log('warn', r.reason))
    }))
  }

  /**
   * Registers a single JSON schema for use in the app
   * @param {String} filePath Path to the schema file
   * @param {RegisterSchemaOptions} options Extra options
   * @return {Promise}
   */
  async registerSchema (filePath, options = {}) {
    if (!_.isString(filePath)) {
      throw this.app.errors.INVALID_PARAMS.setData({ params: ['filePath'] })
    }
    const schema = await this.createSchema(filePath, options)

    if (this.schemas[schema.name]) {
      if (options.replace) this.deregisterSchema(schema.name)
      else throw this.app.errors.SCHEMA_EXISTS.setData({ name: schema.name, filepath: filePath })
    }
    this.schemas[schema.name] = schema
    this.schemaExtensions?.[schema.name]?.forEach(s => schema.addExtension(s))
    if (schema.raw.$patch) this.extendSchema(schema.raw.$patch?.source?.$ref, schema.name)

    this.log('debug', 'REGISTER_SCHEMA', schema.name, filePath)
  }

  /**
   * deregisters a single JSON schema
   * @param {String} name Schem name to deregister
   * @return {Promise} Resolves with schema data
   */
  deregisterSchema (name) {
    if (this.schemas[name]) delete this.schemas[name]
    this.log('debug', 'DEREGISTER_SCHEMA', name)
  }

  /**
   * Creates a new JsonSchema instance
   * @param {String} filePath Path to the schema file
   * @returns {JsonSchema}
   */
  createSchema (filePath, options) {
    const schema = new JsonSchema({
      enableCache: this.getConfig('enableCache'),
      filePath,
      validator: this.validator,
      xssWhitelist: this.getConfig('xssWhitelist'),
      ...options
    })
    this.schemaExtensions?.[schema.name]?.forEach(s => schema.addExtension(s))
    delete this.schemaExtensions?.[schema.name]
    return schema.load()
  }

  /**
   * Extends an existing schema with extra properties
   * @param {String} baseSchemaName The name of the schema to extend
   * @param {String} extSchemaName The name of the schema to extend with
   */
  extendSchema (baseSchemaName, extSchemaName) {
    const baseSchema = this.schemas[baseSchemaName]
    if (baseSchema) {
      baseSchema.addExtension(extSchemaName)
    } else {
      if (!this.schemaExtensions[baseSchemaName]) this.schemaExtensions[baseSchemaName] = []
      this.schemaExtensions[baseSchemaName].push(extSchemaName)
    }
    this.log('debug', 'EXTEND_SCHEMA', baseSchemaName, extSchemaName)
  }

  /**
   * Retrieves the specified schema. Recursively applies any schema merge/patch schemas. Will returned cached data if enabled.
   * @param {String} schemaName The name of the schema to return
   * @param {LoadSchemaOptions} options
   * @param {Boolean} options.compiled If false, the raw schema will be returned
   * @return {Promise} The compiled schema validation function (default) or the raw schema
   */
  async getSchema (schemaName, options = {}) {
    const schema = this.schemas[schemaName]
    if (!schema) throw this.app.errors.NOT_FOUND.setData({ type: 'schema', id: schemaName })
    return schema.build(options)
  }
}

export default JsonSchemaModule
