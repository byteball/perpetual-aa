// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai')
const { promisify } = require('util')
const path = require('path')
const fs = require('fs')
const objectHash = require("ocore/object_hash.js");
const parseOjson = require('ocore/formula/parse_ojson').parse

async function getAaAddress(aa_src) {
	return objectHash.getChash160(await promisify(parseOjson)(aa_src));
}

function round(n, precision) {
	return parseFloat(n.toPrecision(precision));
}


describe('Various trades in perpetual', function () {
	this.timeout(120000)

	before(async () => {

		const staking_lib = fs.readFileSync(path.join(__dirname, '../staking-lib.oscript'), 'utf8');
		const staking_lib_address = await getAaAddress(staking_lib);

		let staking_base = fs.readFileSync(path.join(__dirname, '../staking.oscript'), 'utf8');
		staking_base = staking_base.replace(/\$lib_aa = '\w{32}'/, `$lib_aa = '${staking_lib_address}'`)
		const staking_base_address = await getAaAddress(staking_base);
		
		let perp_base = fs.readFileSync(path.join(__dirname, '../perpetual.oscript'), 'utf8');
		perp_base = perp_base.replace(/\$staking_base_aa = '\w{32}'/, `$staking_base_aa = '${staking_base_address}'`)
		const perp_base_address = await getAaAddress(perp_base);
		
		let factory = fs.readFileSync(path.join(__dirname, '../factory.oscript'), 'utf8');
		factory = factory.replace(/\$base_aa = '\w{32}'/, `$base_aa = '${perp_base_address}'`)

		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.asset({ ousd: {} })
			.with.asset({ oswap: {} }) // reward asset
			.with.agent({ price_base: path.join(__dirname, '../price.oscript') })
			.with.agent({ staking_lib: path.join(__dirname, '../staking-lib.oscript') })
			.with.agent({ staking_base })
			.with.agent({ perp_base })
			.with.agent({ factory })
			.with.wallet({ oracle: {base: 1e9} })
			.with.wallet({ alice: {base: 100e9, ousd: 10000e9} })
			.with.wallet({ bob: {base: 100e9, ousd: 10000e9} })
			.with.wallet({ osw: {base: 100e9, oswap: 10000e9} })
		//	.with.explorer()
			.run()
		
		console.log('--- agents\n', this.network.agent)
		console.log('--- assets\n', this.network.asset)

		this.ousd = this.network.asset.ousd
		this.oswap = this.network.asset.oswap

		this.oracle = this.network.wallet.oracle
		this.oracleAddress = await this.oracle.getAddress()
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		this.osw = this.network.wallet.osw

		this.multiplier = 1e-4
		const { address: btc_price_aa_address, error } = await this.alice.deployAgent({
			base_aa: this.network.agent.price_base,
			params: {
				oracle: this.oracleAddress,
				feed_name: 'BTC_USD',
				multiplier: this.multiplier,
			}
		})
		expect(error).to.be.null
		this.btc_price_aa_address = btc_price_aa_address

		this.executeGetter = async (getter, args = []) => {
			const { result, error } = await this.alice.executeGetter({
				aaAddress: this.perp_aa,
				getter,
				args
			})
			expect(error).to.be.null
			return result
		}

		this.timetravel = async (shift = '1d') => {
			const { error, timestamp } = await this.network.timetravel({ shift })
			expect(error).to.be.null
		}

		this.get_price = async (asset, bWithPriceAdjustment = true) => {
			return await this.executeGetter('get_price', [asset, bWithPriceAdjustment])
		}

		this.get_auction_price = async (asset) => {
			return await this.executeGetter('get_auction_price', [asset])
		}

		this.checkCurve = async () => {
			const { vars } = await this.alice.readAAStateVars(this.perp_aa)
			const { state } = vars
			const { reserve, s0, a0, coef } = state
			let sum = a0 * s0 ** 2
			for (let var_name in vars)
				if (var_name.startsWith('asset_')) {
					const { supply, a } = vars[var_name]
					if (supply && a)
						sum += a * supply ** 2
				}
			const r = coef * Math.sqrt(sum)
			expect(r).to.be.closeTo(reserve, 6)
		}

	})

	it('Post data feed', async () => {
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					BTC_USD: 20000,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload).to.deep.equalInAnyOrder({
			BTC_USD: 20000,
		})
	})

	it('Bob defines a new perp', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null
		
	//	this.reserve_asset = 'base'
		this.reserve_asset = this.ousd
		this.swap_fee = 0.003
		this.arb_profit_tax = 0.9
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.factory,
			amount: 10000,
			data: {
				reserve_asset: this.reserve_asset,
				swap_fee: this.swap_fee,
				arb_profit_tax: this.arb_profit_tax,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		this.perp_aa = response.response.responseVars.address
		expect(this.perp_aa).to.be.validAddress

		const { vars: perp_vars } = await this.bob.readAAStateVars(this.perp_aa)
		console.log({ perp_vars })
		this.staking_aa = perp_vars.staking_aa
		this.asset0 = perp_vars.state.asset0
		expect(this.asset0).to.be.validUnit

		const { vars: staking_vars } = await this.bob.readAAStateVars(this.staking_aa)
		console.log('staking vars', staking_vars)

		this.coef = 1

		this.network_fee_on_top = this.reserve_asset === 'base' ? 1000 : 0
		this.bounce_fees = this.reserve_asset !== 'base' && { base: [{ address: this.perp_aa, amount: 1e4 }] }
		this.bounce_fee_on_top = this.reserve_asset === 'base' ? 1e4 : 0

	})


	it('Alice buys asset0', async () => {
		const amount = 100e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.perp_aa, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					asset: this.asset0,
				}
			}]
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
	/*	expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])*/

		const { vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		await this.checkCurve()
	})

	it('Alice stakes asset0', async () => {
		const amount = Math.floor(this.state.s0/2)
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.asset0]: [{ address: this.staking_aa, amount: amount }],
				base: [{ address: this.staking_aa, amount: 1e4 }],
			},
			messages: [{
				app: 'data',
				payload: {
					deposit: 1,
					term: 360,
					voted_group_key: 'g1',
					percentages: {a0: 100},
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking vars', vars)
		this.perp_vps_g1 = vars.perp_vps_g1

		this.alice_vp = vars['user_' + this.aliceAddress + '_a0'].normalized_vp
		expect(this.alice_vp).to.equalWithPrecision(amount * 8**((response.timestamp - 1657843200)/360/24/3600), 12)

		await this.checkCurve()
	})

	it('Alice votes for addition of BTC asset', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.staking_aa,
			amount: 10000,
			data: {
				vote_value: 1,
				name: 'add_price_aa',
				price_aa: this.btc_price_aa_address,
				value: 'yes',
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.alice, response.response_unit)
		this.btc_asset = response2.response.responseVars.asset
		expect(this.btc_asset).to.be.validUnit

		const { vars: staking_vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking vars', staking_vars)
		
		const { vars: perp_vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', perp_vars)

		await this.checkCurve()
	})

	it('Alice buys BTC-pegged asset in a presale', async () => {
		const amount = 1e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.perp_aa, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					asset: this.btc_asset,
					presale: 1,
				}
			}]
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		await this.checkCurve()
	})


	it('Alice withdraws BTC-pegged asset from the presale', async () => {
		await this.timetravel('14d')
		const new_issued_tokens = Math.floor(1e9 / 20000 / this.multiplier)
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.perp_aa,
			amount: 10000,
			data: {
				claim: 1,
				asset: this.btc_asset,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.btc_asset,
				address: this.aliceAddress,
				amount: new_issued_tokens,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		await this.checkCurve()
	})


	it('Alice buys more BTC', async () => {
		const amount = 1e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.perp_aa, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					asset: this.btc_asset,
				}
			}]
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
	/*	expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])*/

		const { vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		await this.checkCurve()

		let price = await this.get_price(this.btc_asset)
		console.log({ price })
		
		await this.timetravel('36h')
		price = await this.get_price(this.btc_asset, true)
		console.log('1.5 days', { price })
		await this.checkCurve()
		
		await this.timetravel('36h')
		price = await this.get_price(this.btc_asset, true)
		console.log('3 days', { price })
		await this.checkCurve()
		
		await this.timetravel('1d')
		price = await this.get_price(this.btc_asset, true)
		console.log('4 days', { price })
		await this.checkCurve()
	})

	it('Alice buys more BTC after the price got corrected', async () => {
		const amount = 1e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.perp_aa, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					asset: this.btc_asset,
				}
			}]
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
	/*	expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])*/

		const { vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		await this.checkCurve()

		let price = await this.get_price(this.btc_asset)
		console.log({ price })
		
	})

	it('Alice votes for addition of pre-IPO SPACEX asset', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.staking_aa,
			amount: 10000,
			data: {
				vote_value: 1,
				name: 'add_preipo',
				symbol: 'SPACEX',
				initial_auction_price: 10,
				max_tokens: 1e9,
				value: 'yes',
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.alice, response.response_unit)
		this.spacex_asset = response2.response.responseVars.asset
		expect(this.spacex_asset).to.be.validUnit

		const { vars: staking_vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking vars', staking_vars)
		
		const { vars: perp_vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', perp_vars)

		await this.checkCurve()
	})

	it('Alice buys SPACEX-pegged asset in a presale after the price has halved', async () => {
		await this.timetravel('3d')
		const amount = 1e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.perp_aa, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					asset: this.spacex_asset,
					presale: 1,
				}
			}]
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		const spacex_price = await this.get_auction_price(this.spacex_asset)
		expect(spacex_price).to.eq(5)

		await this.checkCurve()
	})

	it('Bob buys SPACEX-pegged asset in a presale after the price has halved again', async () => {
		await this.timetravel('3d')
		const amount = 1e9
		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.perp_aa, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					asset: this.spacex_asset,
					presale: 1,
				}
			}]
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.bob.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		const spacex_price = await this.get_auction_price(this.spacex_asset)
		expect(spacex_price).to.eq(2.5)

		await this.checkCurve()
	})


	it('Alice withdraws SPACEX-pegged asset from the presale', async () => {
		await this.timetravel('8d')
		const new_issued_tokens = Math.floor(1e9 / 2.5)
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.perp_aa,
			amount: 10000,
			data: {
				claim: 1,
				asset: this.spacex_asset,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.spacex_asset,
				address: this.aliceAddress,
				amount: new_issued_tokens,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		await this.checkCurve()
	})


	it('Bob withdraws SPACEX-pegged asset from the presale', async () => {
		const new_issued_tokens = Math.floor(1e9 / 2.5)
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.perp_aa,
			amount: 10000,
			data: {
				claim: 1,
				asset: this.spacex_asset,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.spacex_asset,
				address: this.bobAddress,
				amount: new_issued_tokens,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		await this.checkCurve()

		let btc_price = await this.get_price(this.btc_asset)
		let spacex_price = await this.get_price(this.spacex_asset)
		console.log({ btc_price, spacex_price })
		
		await this.timetravel('36h')
		btc_price = await this.get_price(this.btc_asset)
		spacex_price = await this.get_price(this.spacex_asset)
		console.log('1.5 days', { btc_price, spacex_price })
		await this.checkCurve()
	})


	it('Alice buys more SPACEX', async () => {
		const amount = 1e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.perp_aa, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					asset: this.spacex_asset,
				}
			}]
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
	/*	expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])*/

		const { vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		await this.checkCurve()

		let btc_price = await this.get_price(this.btc_asset)
		let spacex_price = await this.get_price(this.spacex_asset)
		console.log({ btc_price, spacex_price })
		
		await this.timetravel('36h')
		btc_price = await this.get_price(this.btc_asset)
		spacex_price = await this.get_price(this.spacex_asset)
		console.log('1.5 days', { btc_price, spacex_price })
		await this.checkCurve()

	})

	it('Alice sells BTC', async () => {
		const amount = 0.5e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.btc_asset]: [{ address: this.perp_aa, amount: amount }],
				base: [{address: this.perp_aa, amount: 1e4}]
			},
			messages: [{
				app: 'data',
				payload: {
					asset: this.btc_asset,
				}
			}]
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
	/*	expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])*/

		const { vars } = await this.alice.readAAStateVars(this.perp_aa)
		console.log('perp vars', vars)
		this.state = vars.state

		await this.checkCurve()

		let btc_price = await this.get_price(this.btc_asset)
		let spacex_price = await this.get_price(this.spacex_asset)
		console.log({ btc_price, spacex_price })
		
		await this.timetravel('36h')
		btc_price = await this.get_price(this.btc_asset)
		spacex_price = await this.get_price(this.spacex_asset)
		console.log('1.5 days', { btc_price, spacex_price })
		await this.checkCurve()

	})


	it('Alice votes for whitelisting of OSWAP token as reward asset', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.staking_aa,
			amount: 10000,
			data: {
				vote_whitelist: 1,
				reward_asset: this.oswap,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		expect(response.response.responseVars.message).to.be.eq("whitelisted")

		const { vars: staking_vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking_vars', staking_vars)
		expect(staking_vars['reward_assets_'+this.oswap]).to.eq('e1')
		expect(staking_vars['emissions']).to.deep.eq({e1: 0})
		
	})

	it('Receive reward asset emissions', async () => {
		const amount = 1e9
		const { unit, error } = await this.osw.sendMulti({
			outputs_by_asset: {
				[this.oswap]: [{ address: this.staking_aa, amount: amount }],
				base: [{address: this.staking_aa, amount: 1e4}]
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.osw, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		expect(response.response.responseVars.message).to.be.eq("accepted emissions")
	
		const { vars: staking_vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking_vars', staking_vars)
		expect(staking_vars['emissions']).to.deep.eq({e1: amount})
	})

	it('Alice moves a part of her VP to BTC and SPACEX assets', async () => {
		const vp = this.alice_vp
		console.log({vp})
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.staking_aa,
			amount: 10000,
			data: {
				vote_shares: 1,
				group_key1: 'g1',
				changes: { a0: -0.4 * vp - 0.2 * vp, a1: 0.4 * vp, a2: 0.2 * vp },
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: staking_vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking_vars', staking_vars)
	})

	it('Alice stakes BTC', async () => {
		const amount = 0.5e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.btc_asset]: [{ address: this.staking_aa, amount: amount }],
				base: [{ address: this.staking_aa, amount: 1e4 }],
			},
			messages: [{
				app: 'data',
				payload: {
					deposit: 1,
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking_vars', vars)
		this.perp_vps_g1 = vars.perp_vps_g1
	})

	it('Bob stakes SPACEX', async () => {
		const amount = Math.floor(1e9/2.5)
		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.spacex_asset]: [{ address: this.staking_aa, amount: amount }],
				base: [{ address: this.staking_aa, amount: 1e4 }],
			},
			messages: [{
				app: 'data',
				payload: {
					deposit: 1,
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking_vars', vars)
		this.perp_vps_g1 = vars.perp_vps_g1
	})


	it('Receive reward asset emissions again', async () => {
		const amount = 2e9
		const { unit, error } = await this.osw.sendMulti({
			outputs_by_asset: {
				[this.oswap]: [{ address: this.staking_aa, amount: amount }],
				base: [{address: this.staking_aa, amount: 1e4}]
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.osw, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		expect(response.response.responseVars.message).to.be.eq("accepted emissions")
	
		const { vars: staking_vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking_vars', staking_vars)
		expect(staking_vars['emissions']).to.deep.eq({e1: 3e9})
	})

	it('Alice harvests OSWAP rewards from staking BTC', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.staking_aa,
			amount: 1e4,
			data: {
				withdraw_rewards: 1,
				perp_asset: this.btc_asset,
				reward_asset: this.oswap,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.oswap,
				address: this.aliceAddress,
				amount: 2e9 * 0.4,
			},
		], 1)

		const { vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking vars', vars)
		expect(vars['asset_' + this.btc_asset].last_emissions).to.deep.eq({e1: 3e9})
		expect(vars['asset_' + this.btc_asset].received_emissions).to.deep.eq({e1: 3e9 * 0.4})
		expect(vars['user_' + this.aliceAddress + '_a1'].last_perp_emissions).to.deep.eq({e1: 3e9 * 0.4})
		this.perp_vps_g1 = vars.perp_vps_g1
	})

	it('Bob harvests OSWAP rewards from staking SPACEX', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.staking_aa,
			amount: 1e4,
			data: {
				withdraw_rewards: 1,
				perp_asset: this.spacex_asset,
				reward_asset: this.oswap,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.oswap,
				address: this.bobAddress,
				amount: 2e9 * 0.2,
			},
		], 1)

		const { vars } = await this.bob.readAAStateVars(this.staking_aa)
		console.log('staking vars', vars)
		expect(vars['asset_' + this.spacex_asset].last_emissions).to.deep.eq({e1: 3e9})
		expect(vars['asset_' + this.spacex_asset].received_emissions.e1).to.closeTo(3e9 * 0.2, 1)
		expect(vars['user_' + this.bobAddress + '_a2'].last_perp_emissions.e1).to.closeTo(3e9 * 0.2, 0.001)
		this.perp_vps_g1 = vars.perp_vps_g1
	})


	it('Receive reward asset emissions #3', async () => {
		const amount = 1e9
		const { unit, error } = await this.osw.sendMulti({
			outputs_by_asset: {
				[this.oswap]: [{ address: this.staking_aa, amount: amount }],
				base: [{address: this.staking_aa, amount: 1e4}]
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.osw, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		expect(response.response.responseVars.message).to.be.eq("accepted emissions")
	
		const { vars: staking_vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking_vars', staking_vars)
		expect(staking_vars['emissions']).to.deep.eq({e1: 4e9})
	})

	it('Alice stakes more BTC and OSWAP rewards get updated', async () => {
		const amount = 0.1e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.btc_asset]: [{ address: this.staking_aa, amount: amount }],
				base: [{ address: this.staking_aa, amount: 1e4 }],
			},
			messages: [{
				app: 'data',
				payload: {
					deposit: 1,
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking vars', vars)
		expect(vars['asset_' + this.btc_asset].last_emissions).to.deep.eq({e1: 4e9})
		expect(vars['asset_' + this.btc_asset].received_emissions).to.deep.eq({e1: 4e9 * 0.4})
		expect(vars['user_' + this.aliceAddress + '_a1'].last_perp_emissions).to.deep.eq({e1: 4e9 * 0.4})
		expect(vars['user_' + this.aliceAddress + '_a1'].rewards).to.deep.eq({e1: 1e9 * 0.4})
		this.perp_vps_g1 = vars.perp_vps_g1
	})


	it('Alice harvests OSWAP rewards from staking asset0', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.staking_aa,
			amount: 1e4,
			data: {
				withdraw_rewards: 1,
				perp_asset: this.asset0,
				reward_asset: this.oswap,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.oswap,
				address: this.aliceAddress,
				amount: 4e9 * 0.4,
			},
		], 1)

		const { vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking vars', vars)
		expect(vars['asset_' + this.asset0].last_emissions).to.deep.eq({e1: 4e9})
		expect(vars['asset_' + this.asset0].received_emissions).to.deep.eq({e1: 4e9 * 0.4})
		expect(vars['user_' + this.aliceAddress + '_a0'].last_perp_emissions).to.deep.eq({e1: 4e9 * 0.4})
		this.perp_vps_g1 = vars.perp_vps_g1
	})

	it('Alice withdraws BTC and harvests OSWAP rewards from staking BTC', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.staking_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				perp_asset: this.btc_asset,
				reward_asset: this.oswap,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.oswap,
				address: this.aliceAddress,
				amount: 1e9 * 0.4,
			},
			{
				asset: this.btc_asset,
				address: this.aliceAddress,
				amount: 0.6e9,
			},
		], 1)

		const { vars } = await this.alice.readAAStateVars(this.staking_aa)
		console.log('staking vars', vars)
		expect(vars['asset_' + this.btc_asset].last_emissions).to.deep.eq({e1: 4e9})
		expect(vars['asset_' + this.btc_asset].received_emissions).to.deep.eq({e1: 4e9 * 0.4})
		expect(vars['user_' + this.aliceAddress + '_a1']).to.be.undefined
		this.perp_vps_g1 = vars.perp_vps_g1
	})

	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
