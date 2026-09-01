<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { KeyRound, LogIn, ShieldCheck } from '@lucide/vue';
import logoUrl from '../assets/moirai-logo.png';
import { errorMessage } from '../error-message';
import { captureRecoveryFragment } from '../recovery-fragment';
import { useAuthenticationStore } from '../stores/authentication';

const route = useRoute();
const router = useRouter();
const authentication = useAuthenticationStore();
const credentials = reactive({ username: '', password: '', confirmation: '' });
const recoveryToken = ref('');
const submitting = ref(false);
const error = ref(route.query.error === 'oidc' ? 'Logto sign-in could not be completed.' : '');

const recovering = computed(() => route.path === '/recover');
const uninitialized = computed(() => authentication.state?.status === 'uninitialized');
const showLocalForm = computed(() => recovering.value
	|| uninitialized.value
	|| authentication.state?.methods.local === true);
const heading = computed(() => recovering.value
	? 'Recover local access'
	: uninitialized.value ? 'Create user' : 'Sign in to Moirai');
const submitLabel = computed(() => recovering.value
	? 'Recover access'
	: uninitialized.value ? 'Create User' : 'Sign In');

/** Return a safe internal destination after authentication succeeds. */
function returnPath(): string {
	const value = typeof route.query.returnTo === 'string' ? route.query.returnTo : '/';
	return value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

/** Create or authenticate the local administrator using the current page mode. */
async function submit(): Promise<void> {
	if ((uninitialized.value || recovering.value) && credentials.password !== credentials.confirmation) {
		error.value = 'Passwords do not match.';
		return;
	}

	submitting.value = true;
	error.value = '';
	try {
		if (recovering.value) {
			await authentication.recover(
				recoveryToken.value,
				credentials.username,
				credentials.password,
			);
		}
		else if (uninitialized.value) {
			await authentication.setup(credentials.username, credentials.password);
		}
		else {
			await authentication.login(credentials.username, credentials.password);
		}

		await router.replace(returnPath());
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		submitting.value = false;
	}
}

/** Redirect through the server-owned Logto authorization transaction. */
function continueWithLogto(): void {
	const query = new URLSearchParams({ returnTo: returnPath() });
	window.location.assign(`/api/v1/auth/logto/start?${query}`);
}

/** Read a recovery token and remove its fragment only after authentication bootstrap succeeds. */
onMounted(() => {
	if (!recovering.value || !window.location.hash) {
		return;
	}

	const captured = captureRecoveryFragment(
		window.location.hash,
		authentication.state !== null && !authentication.loadError,
	);
	recoveryToken.value = captured.token;
	if (captured.clearFragment) {
		window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
	}
});
</script>

<template>
	<main class="authentication-shell">
		<section class="panel authentication-card">
			<header class="authentication-heading">
				<p class="eyebrow">Moirai administration</p>
				<img :src="logoUrl" alt="" />
				<h1>{{ heading }}</h1>
			</header>

			<p v-if="authentication.loadError" class="notice error" role="alert">
				{{ authentication.loadError }}
			</p>
			<p v-if="error" class="notice error" role="alert">{{ error }}</p>
			<div
				v-if="!authentication.loadError && !recovering && authentication.state?.methods.logto"
				class="authentication-provider"
			>
				<button class="button secondary" type="button" @click="continueWithLogto">
					<LogIn :size="17" />Sign In with Logto
				</button>
				<span v-if="showLocalForm">
					{{ uninitialized ? 'or create a local user' : 'or sign in locally' }}
				</span>
			</div>

			<form
				v-if="!authentication.loadError && showLocalForm"
				class="form-grid authentication-form"
				@submit.prevent="submit"
			>
				<label class="span-2">
					<span>Username</span>
					<input
						v-model="credentials.username"
						autocomplete="username"
						minlength="3"
						maxlength="64"
						required
					/>
				</label>
				<label class="span-2">
					<span>{{ uninitialized || recovering ? 'New password' : 'Password' }}</span>
					<input
						v-model="credentials.password"
						type="password"
						:autocomplete="uninitialized || recovering ? 'new-password' : 'current-password'"
						minlength="15"
						maxlength="256"
						required
					/>
					<small v-if="uninitialized || recovering">Use at least 15 characters.</small>
				</label>
				<label v-if="uninitialized || recovering" class="span-2">
					<span>Confirm password</span>
					<input
						v-model="credentials.confirmation"
						type="password"
						autocomplete="new-password"
						minlength="15"
						maxlength="256"
						required
					/>
				</label>
				<label v-if="recovering" class="span-2">
					<span>Recovery code</span>
					<input v-model="recoveryToken" autocomplete="off" required />
				</label>
				<div class="form-actions span-2">
					<button class="button" :disabled="submitting">
						<KeyRound v-if="recovering" :size="17" />
						<ShieldCheck v-else-if="uninitialized" :size="17" />
						<LogIn v-else :size="17" />
						{{ submitLabel }}
					</button>
				</div>
			</form>

			<p
				v-if="!authentication.loadError && !showLocalForm && !authentication.state?.methods.logto"
				class="notice warning"
			>
				No sign-in method is currently available. Run <code>npm run auth:reset</code> on the
				server to create a local recovery code.
			</p>
		</section>
	</main>
</template>
